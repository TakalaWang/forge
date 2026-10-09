export type ModuleWorkerOptions = Omit<WorkerOptions, "type">;

export interface ModuleWorkerBootstrap {
  /** Same-origin blob URL that imports the emitted module Worker entry. */
  readonly url: string;
  /** Release the blob URL after every Worker that needs it has been constructed. */
  revoke(): void;
}

interface ModuleWorkerGlobal {
  __wasmOjModuleWorkerBaseUrl?: unknown;
}

/**
 * Starts an emitted module Worker through a same-origin blob bootstrap.
 *
 * Some production hosts apply COOP/COEP to application responses but serve
 * immutable assets outside that response pipeline. Loading the emitted asset
 * directly as a Worker is then blocked before its module fetch can use CORS.
 * A blob bootstrap keeps the Worker entry same-origin while its module import
 * loads the content-addressed entry with the normal module-script policy.
 */
export function createModuleWorker(
  scriptUrl: string | URL,
  options: ModuleWorkerOptions = {},
): Worker {
  const bootstrap = createModuleWorkerBootstrap(scriptUrl, { liveness: true });
  let worker: Worker;
  try {
    worker = new Worker(bootstrap.url, { ...options, type: "module" });
  } finally {
    bootstrap.revoke();
  }
  superviseLiveness(worker, options.name);
  return worker;
}

/**
 * Creates a reusable blob bootstrap for APIs such as the Wasmer SDK that own
 * Worker construction and may defer it until a command is instantiated.
 * `liveness` makes the Worker hold and report its liveness lock; only
 * `createModuleWorker`, which consumes that report, enables it.
 */
export function createModuleWorkerBootstrap(
  scriptUrl: string | URL,
  { liveness = false }: { liveness?: boolean } = {},
): ModuleWorkerBootstrap {
  const baseUrl = moduleWorkerBaseUrl();
  const absoluteScriptUrl = resolveModuleWorkerUrl(scriptUrl);
  const bootstrap = new Blob(
    [
      "const pendingMessages = [];\n",
      "const queueMessage = (event) => { event.stopImmediatePropagation(); pendingMessages.push(event.data); };\n",
      'globalThis.addEventListener("message", queueMessage);\n',
      `Object.defineProperty(globalThis, "__wasmOjModuleWorkerBaseUrl", { value: ${JSON.stringify(baseUrl.href)} });\n`,
      ...(liveness ? [LIVENESS_BOOTSTRAP] : []),
      `try { await import(${JSON.stringify(absoluteScriptUrl)}); } finally { globalThis.removeEventListener("message", queueMessage); }\n`,
      'for (const data of pendingMessages) globalThis.dispatchEvent(new MessageEvent("message", { data }));\n',
    ],
    { type: "text/javascript" },
  );
  const bootstrapUrl = URL.createObjectURL(bootstrap);
  let active = true;
  return {
    url: bootstrapUrl,
    revoke() {
      if (!active) return;
      active = false;
      URL.revokeObjectURL(bootstrapUrl);
    },
  };
}

const LIVENESS_MESSAGE_KEY = "__wasmOjWorkerLiveness";

const LIVENESS_BOOTSTRAP = "try { const lock = \"wasm-oj-worker-\" + crypto.randomUUID(); "
  + `navigator.locks.request(lock, () => { postMessage({ ${LIVENESS_MESSAGE_KEY}: lock }); return new Promise(() => {}); }).catch(() => {}); } catch {}\n`;

interface WorkerLiveness {
  lost?: Error;
  readonly listeners: Set<(error: Error) => void>;
}

const liveness = new WeakMap<Worker, WorkerLiveness>();

/**
 * Calls `listener` once if `worker`, created by `createModuleWorker`, stops
 * without an `error` event before its owner calls `terminate()`, for example
 * because the browser terminated it. Owners treat this like a crash. Without
 * Web Locks the listener is never called and the previous behaviour remains.
 */
export function onModuleWorkerLost(worker: Worker, listener: (error: Error) => void): void {
  const state = liveness.get(worker);
  if (!state) return;
  if (state.lost) {
    const lost = state.lost;
    queueMicrotask(() => listener(lost));
    return;
  }
  state.listeners.add(listener);
}

/**
 * The bootstrap holds a uniquely named Web Lock until its context is destroyed
 * and reports the name. Requesting the same lock here is granted only once the
 * Worker is gone; unless its owner terminated it first, that is reported to
 * `onModuleWorkerLost` listeners. They are called directly rather than through
 * an `error` event because WebKit drops events dispatched on a Worker after
 * `terminate()`.
 */
function superviseLiveness(worker: Worker, name: string | undefined): void {
  const state: WorkerLiveness = { listeners: new Set() };
  liveness.set(worker, state);
  const owner = new AbortController();
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    owner.abort();
    state.listeners.clear();
    terminate();
  };
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const lock = livenessLock(event.data);
    if (lock === undefined) return;
    event.stopImmediatePropagation();
    const locks = globalThis.navigator?.locks;
    if (!locks) return;
    void locks.request(lock, { signal: owner.signal }, () => {
      if (owner.signal.aborted) return;
      const lost = new Error(`The ${name ?? "module"} Worker stopped without reporting an error.`);
      state.lost = lost;
      const listeners = [...state.listeners];
      state.listeners.clear();
      for (const listener of listeners) listener(lost);
    }).catch(() => undefined);
  });
}

function livenessLock(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const lock = (data as Record<string, unknown>)[LIVENESS_MESSAGE_KEY];
  return typeof lock === "string" ? lock : undefined;
}

export function moduleWorkerBaseUrl(): URL {
  const locationHref = globalThis.location?.href;
  if (locationHref) {
    const locationUrl = new URL(locationHref);
    if (locationUrl.protocol === "http:" || locationUrl.protocol === "https:") return locationUrl;
    if (locationUrl.protocol !== "blob:") {
      throw new Error("A module Worker requires an HTTP(S) browser base URL.");
    }
  }

  const injected = (globalThis as ModuleWorkerGlobal).__wasmOjModuleWorkerBaseUrl;
  if (typeof injected !== "string") throw new Error("A module Worker requires a browser base URL.");

  const baseUrl = new URL(injected);
  if (baseUrl.origin === "null" || (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")) {
    throw new Error("A module Worker requires an HTTP(S) browser base URL.");
  }
  return baseUrl;
}

function resolveModuleWorkerUrl(scriptUrl: string | URL): string {
  const baseUrl = moduleWorkerBaseUrl();
  let resolved: URL;
  try {
    resolved = new URL(scriptUrl instanceof URL ? scriptUrl.href : scriptUrl, baseUrl);
  } catch {
    throw new Error("A module Worker URL must be a valid same-origin HTTP(S) URL.");
  }
  if (resolved.origin !== baseUrl.origin
    || resolved.username
    || resolved.password
    || resolved.search
    || resolved.hash) {
    throw new Error("A module Worker URL must be same-origin and contain no credentials, query, or fragment.");
  }
  return resolved.href;
}
