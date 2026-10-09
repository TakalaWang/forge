import { onModuleWorkerLost } from "./module-worker";

export type IsolatedStageResponse<Result> =
  | { type: "result"; result: Result }
  | { type: "shutdown-complete" }
  | { type: "error"; message: string; stack?: string };

interface PersistentRunRequest<Result> {
  kind: "run";
  resolve(result: Result): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PersistentShutdownRequest {
  kind: "shutdown";
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type PersistentStageRequest<Result> = PersistentRunRequest<Result> | PersistentShutdownRequest;

export interface PersistentIsolatedStageOptions {
  createWorker(): Worker;
  timeoutMs: number;
  stageLabel: string;
}

/**
 * Owns one serialized stage Worker for toolchains whose runtime has a thread
 * pool. Reuse keeps immutable compiler state warm and avoids rebuilding the
 * complete Wasmer worker tree for every edit/build cycle.
 */
export class PersistentIsolatedStage<Request, Result> {
  private readonly options: PersistentIsolatedStageOptions;
  private readonly worker: Worker;
  private pending: PersistentStageRequest<Result> | undefined;
  private fault: Error | undefined;
  private disposed = false;
  private closing = false;
  private workerTerminated = false;

  constructor(options: PersistentIsolatedStageOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("A persistent isolated stage requires a positive finite timeout.");
    }
    if (!options.stageLabel.trim()) {
      throw new Error("A persistent isolated stage requires a non-empty label.");
    }
    this.options = options;
    this.worker = options.createWorker();
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", this.onMessageError);
    onModuleWorkerLost(this.worker, (error) => this.fail(error));
  }

  run(request: Request): Promise<Result> {
    if (this.disposed) throw new Error(`The persistent ${this.options.stageLabel} stage is disposed.`);
    if (this.closing) throw new Error(`The persistent ${this.options.stageLabel} stage is shutting down.`);
    if (this.fault) throw this.fault;
    if (this.pending) {
      throw new Error(`The persistent ${this.options.stageLabel} stage accepts one request at a time.`);
    }

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(
          `The persistent ${this.options.stageLabel} stage exceeded ${this.options.timeoutMs} ms.`,
        ));
      }, this.options.timeoutMs);
      this.pending = { kind: "run", resolve, reject, timer };
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  shutdown(request: Request): Promise<void> {
    if (this.disposed) throw new Error(`The persistent ${this.options.stageLabel} stage is disposed.`);
    if (this.closing) throw new Error(`The persistent ${this.options.stageLabel} stage is already shutting down.`);
    if (this.fault) throw this.fault;
    if (this.pending) {
      throw new Error(`The persistent ${this.options.stageLabel} stage cannot shut down during a request.`);
    }
    this.closing = true;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(
          `The persistent ${this.options.stageLabel} shutdown exceeded ${this.options.timeoutMs} ms.`,
        ));
      }, this.options.timeoutMs);
      this.pending = { kind: "shutdown", resolve, reject, timer };
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.terminateWorker();
    this.rejectPending(new Error(`The persistent ${this.options.stageLabel} stage was disposed.`));
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data;
    if (!isStageResponse<Result>(response)) {
      this.fail(new Error(`The persistent ${this.options.stageLabel} worker returned an invalid response.`));
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.fail(new Error(`The persistent ${this.options.stageLabel} worker returned an unsolicited response.`));
      return;
    }

    if (pending.kind === "shutdown") {
      if (response.type !== "shutdown-complete") {
        this.fail(new Error(
          response.type === "error"
            ? response.message
            : `The persistent ${this.options.stageLabel} worker returned an invalid shutdown response.`,
        ));
        return;
      }
      const completed = this.takePending();
      if (!completed || completed.kind !== "shutdown") return;
      this.disposed = true;
      this.detach();
      this.terminateWorker();
      completed.resolve();
      return;
    }

    if (response.type === "shutdown-complete") {
      this.fail(new Error(`The persistent ${this.options.stageLabel} worker shut down during an active request.`));
      return;
    }
    const completed = this.takePending();
    if (!completed || completed.kind !== "run") return;
    if (response.type === "result") {
      completed.resolve(response.result);
      return;
    }
    const error = new Error(response.message);
    if (response.stack !== undefined) error.stack = response.stack;
    completed.reject(error);
  };

  private readonly onError = (event: ErrorEvent): void => {
    event.preventDefault();
    this.fail(new Error(workerErrorMessage(event, `The persistent ${this.options.stageLabel} worker crashed.`)));
  };

  private readonly onMessageError = (): void => {
    this.fail(new Error(`The persistent ${this.options.stageLabel} worker returned an unreadable response.`));
  };

  private fail(error: Error): void {
    if (this.fault || this.disposed) return;
    this.fault = error;
    this.detach();
    this.terminateWorker();
    this.rejectPending(error);
  }

  private takePending(): PersistentStageRequest<Result> | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectPending(error: Error): void {
    this.takePending()?.reject(error);
  }

  private detach(): void {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
  }

  private terminateWorker(): void {
    if (this.workerTerminated) return;
    this.workerTerminated = true;
    this.worker.terminate();
  }
}

/** Run one disposable stage Worker with exactly-once listener/timer cleanup. */
export function runIsolatedStage<Request, Result>(
  worker: Worker,
  request: Request,
  timeoutMs: number,
  stageLabel: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      worker.terminate();
      complete();
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const response = event.data;
      if (!isStageResponse<Result>(response)) {
        finish(() => reject(new Error(`The isolated ${stageLabel} worker returned an invalid response.`)));
        return;
      }
      finish(() => {
        if (response.type === "result") {
          resolve(response.result);
          return;
        }
        if (response.type === "shutdown-complete") {
          reject(new Error(`The isolated ${stageLabel} worker returned a shutdown response.`));
          return;
        }
        const error = new Error(response.message);
        if (response.stack !== undefined) error.stack = response.stack;
        reject(error);
      });
    };
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      finish(() => reject(new Error(workerErrorMessage(event, `The isolated ${stageLabel} worker crashed.`))));
    };
    const onMessageError = () => {
      finish(() => reject(new Error(`The isolated ${stageLabel} worker returned an unreadable response.`)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`The isolated ${stageLabel} stage exceeded ${timeoutMs} ms.`)));
    }, timeoutMs);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    onModuleWorkerLost(worker, (error) => finish(() => reject(error)));
    try {
      worker.postMessage(request);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function isStageResponse<Result>(value: unknown): value is IsolatedStageResponse<Result> {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return response.type === "result"
    ? Object.hasOwn(response, "result")
    : response.type === "shutdown-complete"
      ? Object.keys(response).length === 1
    : response.type === "error"
      && typeof response.message === "string"
      && (response.stack === undefined || typeof response.stack === "string");
}

function workerErrorMessage(event: ErrorEvent, fallback: string): string {
  const message = event.message || fallback;
  const location = event.filename
    ? `${event.filename}${event.lineno > 0 ? `:${event.lineno}${event.colno > 0 ? `:${event.colno}` : ""}` : ""}`
    : "";
  return location ? `${message} (${location})` : message;
}
