import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModuleWorker,
  createModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
  onModuleWorkerLost,
} from "./module-worker";

interface WorkerConstruction {
  url: string | URL;
  options?: WorkerOptions;
}

const constructions: WorkerConstruction[] = [];
const workers: FakeWorker[] = [];

class FakeWorker extends EventTarget {
  terminated = false;

  constructor(url: string | URL, options?: WorkerOptions) {
    super();
    constructions.push({ url, options });
    workers.push(this);
  }

  terminate(): void {
    this.terminated = true;
  }
}

interface LockRequest {
  name: string;
  signal: AbortSignal;
  grant(): void;
}

const lockRequests: LockRequest[] = [];
const fakeLocks = {
  request(name: string, options: { signal: AbortSignal }, callback: () => void): Promise<void> {
    return new Promise((resolve) => {
      lockRequests.push({ name, signal: options.signal, grant: () => resolve(callback()) });
    });
  },
};

beforeEach(() => {
  constructions.length = 0;
  workers.length = 0;
  lockRequests.length = 0;
  vi.stubGlobal("navigator", { locks: fakeLocks });
  vi.stubGlobal("location", {
    href: "https://wasm-oj.example/judge",
    origin: "https://wasm-oj.example",
  });
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://wasm-oj.example/bootstrap");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("module Worker bootstrap", () => {
  it("loads a relative emitted module through an absolute static import", async () => {
    const worker = createModuleWorker("/assets/compiler.worker.js", { name: "wasm-oj-compiler" });

    expect(worker).toBeInstanceOf(FakeWorker);
    expect(constructions).toEqual([{
      url: "blob:https://wasm-oj.example/bootstrap",
      options: { name: "wasm-oj-compiler", type: "module" },
    }]);
    const bootstrap = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(bootstrap).toBeInstanceOf(Blob);
    expect(await (bootstrap as Blob).text()).toBe([
      "const pendingMessages = [];",
      "const queueMessage = (event) => { event.stopImmediatePropagation(); pendingMessages.push(event.data); };",
      'globalThis.addEventListener("message", queueMessage);',
      'Object.defineProperty(globalThis, "__wasmOjModuleWorkerBaseUrl", { value: "https://wasm-oj.example/judge" });',
      'try { const lock = "wasm-oj-worker-" + crypto.randomUUID(); navigator.locks.request(lock, () => { postMessage({ __wasmOjWorkerLiveness: lock }); return new Promise(() => {}); }).catch(() => {}); } catch {}',
      'try { await import("https://wasm-oj.example/assets/compiler.worker.js"); } finally { globalThis.removeEventListener("message", queueMessage); }',
      'for (const data of pendingMessages) globalThis.dispatchEvent(new MessageEvent("message", { data }));',
      "",
    ].join("\n"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://wasm-oj.example/bootstrap");
  });

  it("revokes the bootstrap URL when Worker construction throws", () => {
    vi.stubGlobal("Worker", class {
      constructor() {
        throw new Error("constructor failed");
      }
    });

    expect(() => createModuleWorker("https://wasm-oj.example/runner.worker.js"))
      .toThrow("constructor failed");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://wasm-oj.example/bootstrap");
  });

  it("rejects cross-origin and decorated module URLs before creating a blob", () => {
    expect(() => createModuleWorker("https://cdn.example/runner.worker.js"))
      .toThrow("must be same-origin");
    expect(() => createModuleWorker("https://wasm-oj.example/runner.worker.js?token=secret"))
      .toThrow("no credentials, query, or fragment");
    expect(() => createModuleWorker("https://wasm-oj.example/runner.worker.js#entry"))
      .toThrow("no credentials, query, or fragment");
    expect(() => createModuleWorker("https://user:secret@wasm-oj.example/runner.worker.js"))
      .toThrow("no credentials, query, or fragment");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps a reusable bootstrap alive until its owner explicitly revokes it", async () => {
    const bootstrap = createModuleWorkerBootstrap("/assets/wasmer-thread.worker.js");

    expect(bootstrap.url).toBe("blob:https://wasm-oj.example/bootstrap");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    const source = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(await (source as Blob).text()).toContain(
      'await import("https://wasm-oj.example/assets/wasmer-thread.worker.js")',
    );
    expect(await (source as Blob).text()).not.toContain("__wasmOjWorkerLiveness");

    bootstrap.revoke();
    bootstrap.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://wasm-oj.example/bootstrap");
  });

  it("reports a Worker whose liveness lock frees before its owner terminates it", async () => {
    const worker = createModuleWorker("/assets/runner.worker.js", { name: "wasm-oj-runner" });
    const messages: unknown[] = [];
    const lost: string[] = [];
    worker.addEventListener("message", (event) => messages.push((event as MessageEvent).data));
    onModuleWorkerLost(worker, (error) => lost.push(error.message));

    worker.dispatchEvent(new MessageEvent("message", { data: { __wasmOjWorkerLiveness: "wasm-oj-worker-1" } }));
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } }));
    expect(messages).toEqual([{ type: "ready" }]);
    expect(lockRequests.map(({ name }) => name)).toEqual(["wasm-oj-worker-1"]);
    expect(lost).toEqual([]);

    lockRequests[0]!.grant();
    expect(lost).toEqual(["The wasm-oj-runner Worker stopped without reporting an error."]);

    const late = await new Promise<string>((resolve) => onModuleWorkerLost(worker, (error) => resolve(error.message)));
    expect(late).toBe("The wasm-oj-runner Worker stopped without reporting an error.");
  });

  it("stops watching a Worker once its owner terminates it", () => {
    const worker = createModuleWorker("/assets/runner.worker.js", { name: "wasm-oj-runner" });
    const lost: Error[] = [];
    onModuleWorkerLost(worker, (error) => lost.push(error));
    worker.dispatchEvent(new MessageEvent("message", { data: { __wasmOjWorkerLiveness: "wasm-oj-worker-2" } }));

    worker.terminate();
    lockRequests[0]!.grant();

    expect(workers[0]?.terminated).toBe(true);
    expect(lockRequests[0]?.signal.aborted).toBe(true);
    expect(lost).toEqual([]);
  });

  it("keeps the previous behaviour when Web Locks are unavailable", () => {
    vi.stubGlobal("navigator", {});
    const worker = createModuleWorker("/assets/runner.worker.js");
    const messages: unknown[] = [];
    worker.addEventListener("message", (event) => messages.push((event as MessageEvent).data));

    worker.dispatchEvent(new MessageEvent("message", { data: { __wasmOjWorkerLiveness: "wasm-oj-worker-3" } }));

    expect(messages).toEqual([]);
    expect(lockRequests).toEqual([]);
  });

  it("uses the injected browser base inside a blob Worker", () => {
    vi.stubGlobal("location", {
      href: "blob:https://wasm-oj.example/bootstrap",
      origin: "null",
    });
    vi.stubGlobal("__wasmOjModuleWorkerBaseUrl", "https://wasm-oj.example/judge");

    expect(moduleWorkerBaseUrl().href).toBe("https://wasm-oj.example/judge");
  });

  it("rejects a relative module URL when no trustworthy base exists", () => {
    vi.stubGlobal("location", {
      href: "blob:https://wasm-oj.example/bootstrap",
      origin: "null",
    });

    expect(() => createModuleWorker("runner.worker.js"))
      .toThrow("requires a browser base URL");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
