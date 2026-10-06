import { spawn, type ChildProcess } from "node:child_process";
import { BoundedByteCollector } from "./bounded-transport.ts";

const STAGE_LOG_LIMIT_BYTES = 1024 * 1024;

export interface ReusableStageOptions {
  script: string;
  label: string;
  /** Upper bound for one fd 3 protocol line. */
  lineLimitBytes: number;
  idleTimeoutMs: number;
  /** Retire the child after this many exchanges; unlimited when omitted. */
  maxExchanges?: number;
  /** SIGTERM grace before SIGKILL when the owner terminates its stages. */
  terminationGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface StageExchangeOutput {
  stdout: string;
  stderr: string;
}

export interface StageExchange<T> {
  /** One protocol line written to the child's stdin. */
  request: string;
  timeoutMs: number;
  timeoutMessage: string;
  /** Handles one fd 3 line and returns true once the response has arrived. */
  line(line: string): boolean;
  /** Validates the response; a rejection discards the child. */
  complete(output: StageExchangeOutput): T | Promise<T>;
}

interface PendingExchange {
  line(line: string): boolean;
  resolve(): void;
  reject(error: Error): void;
  stdout: BoundedByteCollector;
  stderr: BoundedByteCollector;
}

/**
 * Child process that serves sequential line-delimited requests on stdin and
 * answers on fd 3. It exits by itself when its stdin reaches EOF, including
 * when the owning process dies.
 */
class StageProcess {
  readonly child: ChildProcess;
  exchanges = 0;
  exited = false;
  private readonly options: ReusableStageOptions;
  private pending: PendingExchange | undefined;
  private buffered = "";

  constructor(options: ReusableStageOptions) {
    this.options = options;
    this.child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      options.script,
    ], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.pending?.stdout.append(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.pending?.stderr.append(chunk));
    this.child.stdin?.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => {
      this.exited = true;
      const stderr = this.pending ? safeText(this.pending.stderr) || safeText(this.pending.stdout) : "";
      this.fail(new Error(stderr.trim() || `The ${options.label} stage exited before it answered.`));
    });
    const responses = this.child.stdio[3];
    if (!responses || typeof responses === "number" || !("on" in responses)) {
      this.child.kill("SIGKILL");
      throw new Error(`The ${options.label} stage did not expose its response channel.`);
    }
    responses.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  exchange(request: string, line: (line: string) => boolean): Promise<StageExchangeOutput> {
    if (this.exited || this.pending) {
      return Promise.reject(new Error(`The ${this.options.label} stage is not available.`));
    }
    this.setReferenced(true);
    return new Promise((resolve, reject) => {
      const kill = (error: Error) => {
        this.child.kill("SIGKILL");
        this.fail(error);
      };
      const pending: PendingExchange = {
        line,
        stdout: new BoundedByteCollector(`The ${this.options.label} stage stdout`, STAGE_LOG_LIMIT_BYTES, kill),
        stderr: new BoundedByteCollector(`The ${this.options.label} stage stderr`, STAGE_LOG_LIMIT_BYTES, kill),
        resolve: () => {
          this.pending = undefined;
          resolve({ stdout: safeText(pending.stdout), stderr: safeText(pending.stderr) });
        },
        reject: (error) => {
          this.pending = undefined;
          reject(error);
        },
      };
      this.pending = pending;
      this.buffered = "";
      this.child.stdin?.write(`${request}\n`);
    });
  }

  idle(): void {
    this.setReferenced(false);
  }

  retire(): void {
    this.setReferenced(false);
    this.child.stdin?.end();
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (!this.exited) this.child.kill(signal);
  }

  private receive(chunk: Buffer): void {
    if (!this.pending) return;
    this.buffered += chunk.toString();
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffered, "utf8") > this.options.lineLimitBytes) {
      this.child.kill("SIGKILL");
      this.fail(new Error(
        `The ${this.options.label} stage response exceeded the ${this.options.lineLimitBytes} byte line boundary.`,
      ));
      return;
    }
    for (const line of lines) {
      const pending = this.pending;
      if (!pending) return;
      try {
        if (line && pending.line(line)) pending.resolve();
      } catch (error) {
        this.child.kill("SIGKILL");
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private fail(error: Error): void {
    this.pending?.reject(error);
  }

  private setReferenced(referenced: boolean): void {
    const handles = [this.child, this.child.stdin, this.child.stdout, this.child.stderr, this.child.stdio[3]];
    for (const handle of handles) {
      const control = handle as { ref?: () => void; unref?: () => void } | null;
      if (referenced) control?.ref?.();
      else control?.unref?.();
    }
  }
}

/**
 * Keeps one stage child warm between sequential exchanges. A failed, timed-out
 * or terminated exchange discards its child; idle children retire after a
 * timeout and never keep the owning process alive.
 */
export class ReusableStage {
  private warm: StageProcess | undefined;
  private active: StageProcess | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: ReusableStageOptions;

  constructor(options: ReusableStageOptions) {
    this.options = options;
  }

  async run<T>(exchange: StageExchange<T>): Promise<T> {
    if (this.active) throw new Error(`The ${this.options.label} stage serves one request at a time.`);
    clearTimeout(this.idleTimer);
    const stage = this.warm && !this.warm.exited ? this.warm : new StageProcess(this.options);
    this.warm = undefined;
    this.active = stage;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        stage.exchange(exchange.request, exchange.line),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(exchange.timeoutMessage)), exchange.timeoutMs);
        }),
      ]);
      const value = await exchange.complete(output);
      stage.exchanges += 1;
      this.release(stage);
      return value;
    } catch (error) {
      stage.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.active === stage) this.active = undefined;
    }
  }

  /** Discard every child; the next exchange starts a new one. */
  terminate(): void {
    clearTimeout(this.idleTimer);
    const stages = [this.active, this.warm].filter((stage): stage is StageProcess => stage !== undefined);
    this.active = undefined;
    this.warm = undefined;
    for (const stage of stages) {
      const grace = this.options.terminationGraceMs;
      if (!grace) {
        stage.kill();
        continue;
      }
      stage.kill("SIGTERM");
      setTimeout(() => stage.kill(), grace).unref();
    }
  }

  private release(stage: StageProcess): void {
    if (this.active !== stage || stage.exited) return;
    if (this.options.maxExchanges !== undefined && stage.exchanges >= this.options.maxExchanges) {
      stage.retire();
      return;
    }
    stage.idle();
    this.warm = stage;
    this.idleTimer = setTimeout(() => {
      if (this.warm !== stage) return;
      this.warm = undefined;
      stage.retire();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }
}

function safeText(collector: BoundedByteCollector): string {
  try {
    return collector.text();
  } catch {
    return "";
  }
}
