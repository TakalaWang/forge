export interface WorkerConstructorHost {
  Worker: typeof Worker;
}

export interface OwnedWorkerRegistryOptions {
  /** Owns only Workers created with a script URL this accepts; others are left alone. */
  owns?: (scriptUrl: string) => boolean;
  /** How long `run` waits after the last owned Worker was terminated before it starts. */
  teardownQuietMs?: number;
}

/**
 * Time a terminated Worker's VM takes to be torn down. A shared memory that grows during that
 * teardown can crash WebKit (see `run`), so new operations wait this long after the last one.
 */
export const OWNED_WORKER_TEARDOWN_QUIET_MS = 250;

/**
 * Gives an owning Worker explicit control over nested Workers created by a
 * dependency that does not expose its own shutdown contract.
 */
export class OwnedWorkerRegistry {
  private readonly host: WorkerConstructorHost;
  private readonly owns: (scriptUrl: string) => boolean;
  private originalWorker!: typeof Worker;
  private originalDescriptor: PropertyDescriptor | undefined;
  private trackedWorker!: typeof Worker;
  private readonly workers = new Map<Worker, () => void>();
  private readonly deferred = new Set<() => void>();
  private readonly teardownQuietMs: number;
  private operations = 0;
  private lastTeardownAt = Number.NEGATIVE_INFINITY;
  private installed = false;

  constructor(host: WorkerConstructorHost, options: OwnedWorkerRegistryOptions = {}) {
    this.host = host;
    this.teardownQuietMs = options.teardownQuietMs ?? OWNED_WORKER_TEARDOWN_QUIET_MS;
    this.owns = options.owns ?? (() => true);
  }

  install(): void {
    if (this.installed) throw new Error("Nested Worker ownership is already installed.");
    this.originalWorker = this.host.Worker;
    this.originalDescriptor = Object.getOwnPropertyDescriptor(this.host, "Worker");
    this.trackedWorker = new Proxy(this.originalWorker, {
      construct: (target, argumentsList, newTarget) => {
        const worker = Reflect.construct(target, argumentsList, newTarget) as Worker;
        if (this.owns(String(argumentsList[0]))) this.own(worker);
        return worker;
      },
    });
    Object.defineProperty(this.host, "Worker", {
      configurable: true,
      enumerable: this.originalDescriptor?.enumerable ?? false,
      writable: true,
      value: this.trackedWorker,
    });
    if (this.host.Worker !== this.trackedWorker) {
      throw new Error("Unable to install nested Worker ownership.");
    }
    this.installed = true;
  }

  /**
   * Runs one operation of the dependency. Its own `terminate()` calls on owned Workers are held
   * until the last running operation ends, and an operation starts only once the last teardown
   * has had `teardownQuietMs` to finish.
   *
   * The Wasmer SDK terminates a thread Worker whenever a WASIX thread or process ends, and starts
   * the next one in a new Worker whose initialization grows the shared `WebAssembly.Memory` that
   * all its Workers import; a C compile does this six to nine times. JavaScriptCore crashes the
   * page (SIGSEGV in `SharedArrayBufferContents::grow`) when a shared memory grows while a Worker
   * whose instance imported it is being torn down, so teardowns are kept away from operations.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const wait = this.lastTeardownAt + this.teardownQuietMs - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.operations += 1;
    try {
      return await operation();
    } finally {
      this.operations -= 1;
      if (this.operations === 0) {
        const deferred = [...this.deferred];
        this.deferred.clear();
        for (const terminate of deferred) terminate();
      }
    }
  }

  /** Restore the host constructor and synchronously terminate every child. */
  terminateAll(): void {
    if (!this.installed) {
      if (this.workers.size > 0) {
        throw new Error("Nested Workers exist without an installed owner.");
      }
      return;
    }
    if (this.host.Worker !== this.trackedWorker) {
      throw new Error("The Worker constructor changed while nested Worker ownership was active.");
    }

    if (this.originalDescriptor) {
      Object.defineProperty(this.host, "Worker", this.originalDescriptor);
    } else if (!Reflect.deleteProperty(this.host, "Worker")) {
      throw new Error("Unable to restore the inherited Worker constructor.");
    }
    if (this.host.Worker !== this.originalWorker) {
      throw new Error("The original Worker constructor was not restored.");
    }
    this.installed = false;

    const owned = [...this.workers.values()];
    this.deferred.clear();
    for (const terminate of owned) terminate();
  }

  get size(): number {
    return this.workers.size;
  }

  private own(worker: Worker): void {
    const terminate = worker.terminate.bind(worker);
    const terminateNow = () => {
      if (!this.workers.delete(worker)) return;
      terminate();
      this.lastTeardownAt = performance.now();
    };
    this.workers.set(worker, terminateNow);
    worker.terminate = () => {
      if (this.operations > 0) this.deferred.add(terminateNow);
      else terminateNow();
    };
  }
}
