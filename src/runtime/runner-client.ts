import {
  createExtendedCostBaselineRegistry,
  resolveArtifactCostBudget,
  snapshotBrowserToolchainSources,
  unavailableExecutionMetrics,
  WEIGHTED_METER_MODEL,
} from "@wasm-oj/core";
import type {
  BuildArtifact,
  BrowserToolchainSource,
  BrowserRuntimeDriverPlugin,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunnerRequest,
  RunnerResponse,
  RunConfig,
  RunResult,
  Runner,
  WorkerProgress,
  CostBaselineRegistry,
} from "@wasm-oj/core";
import RunnerWorkerUrl from "./runner.worker?worker&url";
import { createModuleWorker, onModuleWorkerLost } from "./module-worker";
import { validateBrowserRuntimeDriverPlugins } from "./browser-runtime-plugin";
import { runtimePreparationTimeoutMs } from "../runner/preparation-timeout-policy";

type ProgressListener = (progress: WorkerProgress) => void;
type StreamListener = (stream: "stdout" | "stderr", chunk: string) => void;

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(reason: Error): void;
  boundaryTimer?: ReturnType<typeof setTimeout>;
  executionTimer?: ReturnType<typeof setTimeout>;
  executionFinished?: boolean;
  timeoutMs?: number;
  timeoutResult?: () => T;
}

interface RunnerOperation {
  kind: "run" | "interact" | "cache-clear";
}

const CONTROL_TIMEOUT_MS = 120_000;

export interface BrowserRunnerOptions {
  /** Explicit, contract-validated browser toolchain packages. */
  toolchains: readonly BrowserToolchainSource[];
  /** Calibrated profiles for downstream languages; canonical WASM-OJ profiles cannot be replaced. */
  additionalCostBaselines?: Readonly<Record<string, number>>;
  /** Trusted same-origin, content-pinned RuntimeDriver modules loaded inside the runner Worker. */
  runtimeDriverPlugins?: readonly BrowserRuntimeDriverPlugin[];
}

type RunnerRequestWithoutId = RunnerRequest extends infer Request
  ? Request extends RunnerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export class BrowserRunner implements Runner {
  private worker: Worker;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly streamListeners = new Set<StreamListener>();
  private readyPromise: Promise<void>;
  private readonly toolchains: readonly BrowserToolchainSource[];
  private readonly additionalCostBaselines: Readonly<Record<string, number>>;
  private readonly runtimeDriverPlugins: readonly BrowserRuntimeDriverPlugin[];
  private readonly costBaselines: CostBaselineRegistry;
  private disposed = false;
  private activeOperation: RunnerOperation | undefined;
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private generation = 0;
  private workerInitialized = false;

  constructor(options: BrowserRunnerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("BrowserRunner requires explicit toolchain options.");
    }
    this.toolchains = snapshotBrowserToolchainSources(options.toolchains);
    this.additionalCostBaselines = Object.freeze({ ...options.additionalCostBaselines });
    this.runtimeDriverPlugins = options.runtimeDriverPlugins?.length
      ? validateBrowserRuntimeDriverPlugins(options.runtimeDriverPlugins, location.href)
      : [];
    this.costBaselines = createExtendedCostBaselineRegistry(this.additionalCostBaselines);
    this.worker = this.createWorker();
    this.readyPromise = this.initializeWorker();
  }

  private initializeWorker(): Promise<void> {
    const ready = this.request<void>({
      type: "initialize",
      toolchains: this.toolchains,
      additionalCostBaselines: this.additionalCostBaselines,
      runtimeDriverPlugins: this.runtimeDriverPlugins,
    }, CONTROL_TIMEOUT_MS);
    // A replacement can be disposed before another run awaits ready(). Keep
    // the rejection visible to callers without letting it become unhandled.
    void ready.catch(() => undefined);
    return ready;
  }

  onProgress(listener: ProgressListener): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onStream(listener: StreamListener): () => void {
    this.assertActive();
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  ready(): Promise<void> {
    this.assertActive();
    return this.readyPromise;
  }

  run(artifact: BuildArtifact, config: RunConfig): Promise<RunResult> {
    return this.track(this.runOperation(artifact, config));
  }

  interact(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult> {
    return this.track(this.interactOperation(contestant, interactor, config));
  }

  private async interactOperation(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult> {
    this.assertActive();
    if (this.activeOperation) throw new Error("BrowserRunner accepts one active operation at a time.");
    const operation: RunnerOperation = { kind: "interact" };
    this.activeOperation = operation;
    const generation = this.generation;
    try {
      await this.readyPromise;
      this.assertActive();
      if (generation !== this.generation) throw new Error("Browser interaction was superseded by a Worker replacement.");
      const started = performance.now();
      const contestantCost = resolveArtifactCostBudget(
        contestant,
        config.contestant.resources.instructionBudget,
        this.costBaselines,
      );
      const interactorCost = resolveArtifactCostBudget(
        interactor,
        config.interactor.resources.instructionBudget,
        this.costBaselines,
      );
      const wallTimeLimitMs = Math.min(
        config.contestant.resources.wallTimeLimitMs,
        config.interactor.resources.wallTimeLimitMs,
      );
      return await this.request<InteractiveRunResult>(
        { type: "interact", contestant, interactor, config },
        wallTimeLimitMs,
        () => ({
          contestant: {
            code: 137,
            stderr: `Interactive wall-time limit ${wallTimeLimitMs} ms exceeded.`,
            termination: "wall-time-limit",
            metrics: unavailableExecutionMetrics(contestantCost, WEIGHTED_METER_MODEL),
          },
          interactor: {
            code: 137,
            stderr: `Interactive wall-time limit ${wallTimeLimitMs} ms exceeded.`,
            termination: "wall-time-limit",
            metrics: unavailableExecutionMetrics(interactorCost, WEIGHTED_METER_MODEL),
          },
          contestantToInteractor: "",
          interactorToContestant: "",
          durationMs: performance.now() - started,
          determinism: { ...config.determinism },
        }),
        Math.max(runtimePreparationTimeoutMs(contestant), runtimePreparationTimeoutMs(interactor)),
      );
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  private async runOperation(artifact: BuildArtifact, config: RunConfig): Promise<RunResult> {
    this.assertActive();
    if (this.activeOperation) throw new Error("BrowserRunner accepts one active operation at a time.");
    const operation: RunnerOperation = { kind: "run" };
    this.activeOperation = operation;
    const generation = this.generation;
    try {
      await this.readyPromise;
      this.assertActive();
      if (generation !== this.generation) throw new Error("Browser execution was superseded by a Worker replacement.");
      const started = performance.now();
      const cost = resolveArtifactCostBudget(artifact, config.resources.instructionBudget, this.costBaselines);
      return await this.request<RunResult>(
        { type: "run", artifact, config },
        config.resources.wallTimeLimitMs,
        () => ({
          code: 137,
          stdout: "",
          stderr: `Wall-time limit ${config.resources.wallTimeLimitMs} ms exceeded.`,
          files: {},
          executionDurationMs: config.resources.wallTimeLimitMs,
          durationMs: performance.now() - started,
          determinism: { ...config.determinism },
          resources: { ...config.resources },
          termination: "wall-time-limit",
          metrics: unavailableExecutionMetrics(cost, WEIGHTED_METER_MODEL),
        }),
        runtimePreparationTimeoutMs(artifact),
      );
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  clearRuntimeCache(): Promise<void> {
    return this.track(this.clearRuntimeCacheOperation());
  }

  private async clearRuntimeCacheOperation(): Promise<void> {
    this.assertActive();
    if (this.activeOperation) throw new Error("BrowserRunner accepts one active operation at a time.");
    const operation: RunnerOperation = { kind: "cache-clear" };
    this.activeOperation = operation;
    const generation = this.generation;
    try {
      await this.readyPromise;
      this.assertActive();
      if (generation !== this.generation) throw new Error("Runtime cache clearing was superseded by a Worker replacement.");
      await this.request<void>({ type: "clear-runtime-cache" }, CONTROL_TIMEOUT_MS);
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.activeOperation?.kind === "cache-clear") return;
    this.replaceWorker(new Error("Execution cancelled."));
  }

  async cancelAndWait(): Promise<void> {
    this.cancel();
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
  }

  restart(): void {
    this.assertActive();
    if (this.activeOperation?.kind === "cache-clear") {
      throw new Error("Cannot restart BrowserRunner while clearing its cache.");
    }
    this.replaceWorker(new Error("Runner worker restarted."));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.activeOperation = undefined;
    this.worker.terminate();
    this.rejectAll(new Error("Runner client disposed."));
    this.progressListeners.clear();
    this.streamListeners.clear();
  }

  private createWorker(): Worker {
    const worker = createModuleWorker(RunnerWorkerUrl, { name: "wasm-oj-runner" });
    worker.addEventListener("message", (event: MessageEvent<RunnerResponse>) => {
      if (!this.disposed && this.worker === worker) this.handleMessage(event.data);
    });
    const crashed = (error: Error) => {
      if (this.disposed || this.worker !== worker) return;
      const canRecover = this.workerInitialized;
      this.stopWorker(error);
      if (canRecover) this.installWorker();
    };
    worker.addEventListener("error", (event) => crashed(new Error(event.message || "The runner worker crashed.")));
    onModuleWorkerLost(worker, crashed);
    return worker;
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearRequestTimers(request);
      request.reject(error);
    }
    this.pending.clear();
  }

  private replaceWorker(error: Error): void {
    this.stopWorker(error);
    this.installWorker();
  }

  private stopWorker(error: Error): void {
    this.generation += 1;
    if (this.activeOperation?.kind === "run" || this.activeOperation?.kind === "interact") {
      this.activeOperation = undefined;
    }
    this.worker.terminate();
    this.rejectAll(error);
    this.workerInitialized = false;
  }

  private installWorker(): void {
    this.worker = this.createWorker();
    this.readyPromise = this.initializeWorker();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("BrowserRunner is disposed.");
  }

  private track<Result>(operation: Promise<Result>): Promise<Result> {
    this.inFlightOperations.add(operation);
    void operation.then(
      () => this.inFlightOperations.delete(operation),
      () => this.inFlightOperations.delete(operation),
    );
    return operation;
  }

  private request<T>(
    request: RunnerRequestWithoutId,
    timeoutMs?: number,
    timeoutResult?: () => T,
    preparationTimeoutMs = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    this.assertActive();
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = { resolve, reject, timeoutMs, timeoutResult };
      this.pending.set(requestId, pending as PendingRequest<unknown>);
      if (timeoutResult) {
        pending.boundaryTimer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          const error = new Error(
            `Runner runtime preparation exceeded the ${preparationTimeoutMs} ms browser boundary.`,
          );
          reject(error);
          if (!this.disposed) this.replaceWorker(error);
        }, preparationTimeoutMs);
      } else if (timeoutMs !== undefined) {
        pending.boundaryTimer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          const error = new Error(`Runner request exceeded the ${timeoutMs} ms browser boundary.`);
          reject(error);
          if (!this.disposed) this.replaceWorker(error);
        }, timeoutMs);
      }
      try {
        this.worker.postMessage({ ...request, requestId } as RunnerRequest);
      } catch (error) {
        this.pending.delete(requestId);
        clearRequestTimers(pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(response: RunnerResponse): void {
    if (response.type === "progress") {
      for (const listener of this.progressListeners) listener(response.progress);
      if (response.progress.phase === "running") this.startWallTimer(response.requestId);
      if (response.progress.phase === "packaging") this.finishWallTimer(response.requestId);
      return;
    }
    if (response.type === "stream") {
      for (const listener of this.streamListeners) listener(response.stream, response.chunk);
      return;
    }

    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    clearRequestTimers(request);

    switch (response.type) {
      case "ready":
        this.workerInitialized = true;
        request.resolve(undefined);
        break;
      case "run-result":
        request.resolve(response.result);
        break;
      case "interactive-result":
        request.resolve(response.result);
        break;
      case "runtime-cache-cleared":
        request.resolve(undefined);
        break;
      case "error":
        request.reject(Object.assign(new Error(response.message), { code: response.code, stack: response.stack }));
        break;
    }
  }

  private finishWallTimer(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request || request.executionTimer === undefined || request.executionFinished) return;
    clearRequestTimers(request);
    request.executionFinished = true;
    request.boundaryTimer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      const error = new Error(
        `Runner result collection exceeded the ${CONTROL_TIMEOUT_MS} ms browser boundary.`,
      );
      request.reject(error);
      if (!this.disposed) this.replaceWorker(error);
    }, CONTROL_TIMEOUT_MS);
  }

  private startWallTimer(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request || request.executionTimer || request.executionFinished || request.timeoutMs === undefined || !request.timeoutResult) return;
    if (request.boundaryTimer) {
      clearTimeout(request.boundaryTimer);
      request.boundaryTimer = undefined;
    }
    request.executionTimer = setTimeout(() => {
      const current = this.pending.get(requestId);
      if (!current || !current.timeoutResult) return;
      this.pending.delete(requestId);
      const result = current.timeoutResult();
      this.replaceWorker(new Error("Runner worker replaced after wall-time termination."));
      current.resolve(result);
    }, request.timeoutMs);
  }
}

function clearRequestTimers(request: PendingRequest<unknown>): void {
  if (request.boundaryTimer) clearTimeout(request.boundaryTimer);
  if (request.executionTimer) clearTimeout(request.executionTimer);
  request.boundaryTimer = undefined;
  request.executionTimer = undefined;
}
