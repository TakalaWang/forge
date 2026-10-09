import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedWorkerRegistry, type WorkerConstructorHost } from "./owned-worker-registry";

class FakeWorker {
  readonly url: string | URL;
  readonly options: WorkerOptions | undefined;
  terminations = 0;

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
  }

  terminate(): void {
    this.terminations += 1;
  }
}

function hostWithOwnConstructor(): WorkerConstructorHost {
  return { Worker: FakeWorker as unknown as typeof Worker };
}

describe("OwnedWorkerRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks dependency-created Workers and restores the exact constructor", () => {
    const host = hostWithOwnConstructor();
    const original = host.Worker;
    const registry = new OwnedWorkerRegistry(host);

    registry.install();
    const first = new host.Worker("first.js") as unknown as FakeWorker;
    const second = new host.Worker("second.js", { type: "module" }) as unknown as FakeWorker;

    expect(registry.size).toBe(2);
    expect(first.url).toBe("first.js");
    expect(second.options).toEqual({ type: "module" });

    registry.terminateAll();

    expect(host.Worker).toBe(original);
    expect(first.terminations).toBe(1);
    expect(second.terminations).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("restores an inherited constructor without leaving an own property", () => {
    const prototype = { Worker: FakeWorker as unknown as typeof Worker };
    const host = Object.create(prototype) as WorkerConstructorHost;
    const registry = new OwnedWorkerRegistry(host);

    registry.install();
    expect(Object.hasOwn(host, "Worker")).toBe(true);
    registry.terminateAll();

    expect(Object.hasOwn(host, "Worker")).toBe(false);
    expect(host.Worker).toBe(prototype.Worker);
  });

  it("wraps the constructor that is current when it is installed", () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host);
    const replaced = class extends FakeWorker {} as unknown as typeof Worker;
    host.Worker = replaced;

    registry.install();
    const worker = new host.Worker("late.js");
    registry.terminateAll();

    expect(worker).toBeInstanceOf(replaced);
    expect((worker as unknown as FakeWorker).terminations).toBe(1);
    expect(host.Worker).toBe(replaced);
  });

  it("fails closed when another owner replaces the constructor", () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host);
    registry.install();
    host.Worker = class extends FakeWorker {} as unknown as typeof Worker;

    expect(() => registry.terminateAll()).toThrow(
      "The Worker constructor changed while nested Worker ownership was active.",
    );
  });

  it("defers the dependency's terminations until its operations end", async () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host, { teardownQuietMs: 0 });
    registry.install();
    let release!: () => void;
    const operation = registry.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const thread = new host.Worker("thread.js") as unknown as FakeWorker;

    thread.terminate();
    expect(thread.terminations).toBe(0);
    expect(registry.size).toBe(1);

    release();
    await operation;
    expect(thread.terminations).toBe(1);
    expect(registry.size).toBe(0);
    thread.terminate();
    expect(thread.terminations).toBe(1);
  });

  it("terminates at once outside operations and waits for the teardown before the next one", async () => {
    vi.useFakeTimers();
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host, { teardownQuietMs: 250 });
    registry.install();
    const thread = new host.Worker("thread.js") as unknown as FakeWorker;
    thread.terminate();
    expect(thread.terminations).toBe(1);

    let started = false;
    const operation = registry.run(async () => { started = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await operation;
    expect(started).toBe(true);
  });

  it("leaves Workers it does not own untouched", async () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host, { owns: (url) => url === "thread.js", teardownQuietMs: 0 });
    registry.install();
    let stage!: FakeWorker;
    await registry.run(async () => {
      stage = new host.Worker("stage.js") as unknown as FakeWorker;
      stage.terminate();
      expect(stage.terminations).toBe(1);
    });
    expect(registry.size).toBe(0);
    expect(Object.hasOwn(stage, "terminate")).toBe(false);
  });

  it("terminates deferred Workers immediately when ownership ends", async () => {
    const host = hostWithOwnConstructor();
    const registry = new OwnedWorkerRegistry(host, { teardownQuietMs: 0 });
    registry.install();
    let thread!: FakeWorker;
    await registry.run(async () => {
      thread = new host.Worker("thread.js") as unknown as FakeWorker;
      thread.terminate();
      registry.terminateAll();
      expect(thread.terminations).toBe(1);
    });
    expect(thread.terminations).toBe(1);
  });
});
