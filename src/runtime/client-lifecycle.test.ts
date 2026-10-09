import { beforeEach, describe, expect, it, vi } from "vitest";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources";
import type {
  BuildArtifact,
  BuildResult,
  BrowserToolchainSource,
  Project,
  RunConfig,
  RunResult,
} from "../core/types";
import { WASM_OJ_LIBCXX_PCH_HEADER } from "../compiler/libcxx-pch";
import { BrowserCompiler } from "./compiler-client";
import { BrowserRunner } from "./runner-client";

const TEST_COST_PROFILE = costProfileId("zig", "wasip1", "release", "test-content");
const TEST_TOOLCHAINS = Object.freeze([{
  kind: "browser",
  baseUrl: "/test-toolchains/",
  descriptor: {
    schema: WASM_OJ_SCHEMAS.toolchainPackage,
    id: "test-toolchains",
    version: "1.0.0",
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    languages: ["javascript", "cpp", "rust", "go", "zig"],
    profiles: [
      { language: "javascript", target: "wasip1", optimization: "release" },
      { language: "cpp", target: "wasip1", optimization: "release" },
      { language: "rust", target: "wasip1", optimization: "release" },
      { language: "go", target: "wasip1", optimization: "release" },
      { language: "zig", target: "wasip1", optimization: "release" },
    ],
    assets: [{
      path: "/toolchains/test.bin",
      bytes: 1,
      sha256: "0".repeat(64),
      exportPath: "./assets/test.bin",
    }],
  },
}] satisfies readonly BrowserToolchainSource[]);

interface FakeWorker {
  readonly messages: unknown[];
  readonly listeners: Map<string, Set<(event: unknown) => void>>;
  readonly lostListeners: Set<(error: Error) => void>;
  terminated: boolean;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

const workerState = vi.hoisted(() => ({
  compilers: [] as FakeWorker[],
  runners: [] as FakeWorker[],
}));

const prefetchBrowserToolchain = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());

vi.mock("./toolchain-prefetch", () => ({ prefetchBrowserToolchain }));
vi.mock("./compiler.worker?worker&url", () => ({ default: "/assets/compiler.worker.js" }));
vi.mock("./runner.worker?worker&url", () => ({ default: "/assets/runner.worker.js" }));
vi.mock("./module-worker", () => ({
  createModuleWorker(scriptUrl: string): FakeWorker {
    const worker: FakeWorker = {
      messages: [],
      listeners: new Map(),
      lostListeners: new Set(),
      terminated: false,
      addEventListener: () => undefined,
      postMessage: () => undefined,
      terminate: () => undefined,
    };
    worker.addEventListener = (type: string, listener: (event: unknown) => void): void => {
      const listeners = worker.listeners.get(type) ?? new Set();
      listeners.add(listener);
      worker.listeners.set(type, listeners);
    };
    worker.postMessage = (message: unknown): void => {
      worker.messages.push(message);
    };
    worker.terminate = (): void => {
      worker.terminated = true;
    };
    const collection = scriptUrl.includes("compiler.worker")
      ? workerState.compilers
      : workerState.runners;
    collection.push(worker);
    return worker;
  },
  onModuleWorkerLost(worker: FakeWorker, listener: (error: Error) => void): void {
    worker.lostListeners.add(listener);
  },
}));

beforeEach(() => {
  workerState.compilers.length = 0;
  workerState.runners.length = 0;
  prefetchBrowserToolchain.mockReset();
  prefetchBrowserToolchain.mockResolvedValue(undefined);
});

describe("browser client lifecycle", () => {
  it("requires explicit toolchains and sends only validated sources to each Worker", () => {
    expect(() => new BrowserCompiler(undefined as never)).toThrow("requires explicit toolchain options");
    expect(() => new BrowserRunner(undefined as never)).toThrow("requires explicit toolchain options");
    expect(() => new BrowserCompiler({ toolchains: [] })).toThrow("At least one explicit");
    expect(() => new BrowserRunner({ toolchains: [] })).toThrow("At least one explicit");
    expect(workerState.compilers).toHaveLength(0);
    expect(workerState.runners).toHaveLength(0);

    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const runner = new BrowserRunner({ toolchains: TEST_TOOLCHAINS });
    const compilerInitialize = requestsOfType(workerState.compilers[0]!, "initialize")[0]!;
    const runnerInitialize = requestsOfType(workerState.runners[0]!, "initialize")[0]!;
    expect(compilerInitialize.toolchains).toEqual(TEST_TOOLCHAINS);
    expect(runnerInitialize.toolchains).toEqual(TEST_TOOLCHAINS);
    expect(compilerInitialize).not.toHaveProperty("assetBaseUrl");
    expect(runnerInitialize).not.toHaveProperty("assetBaseUrl");
    compiler.dispose();
    runner.dispose();
  });

  it("fails closed when compiler and runner Workers cannot load", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const compilerWorker = workerState.compilers[0]!;
    const compilerReady = expect(compiler.ready()).rejects.toThrow("compiler load failed");
    dispatch(compilerWorker, "error", { message: "compiler load failed" });
    await compilerReady;
    expect(compilerWorker.terminated).toBe(true);
    expect(workerState.compilers).toHaveLength(1);

    const runner = new BrowserRunner({ toolchains: TEST_TOOLCHAINS });
    const runnerWorker = workerState.runners[0]!;
    const runnerReady = expect(runner.ready()).rejects.toThrow("runner load failed");
    dispatch(runnerWorker, "error", { message: "runner load failed" });
    await runnerReady;
    expect(runnerWorker.terminated).toBe(true);
    expect(workerState.runners).toHaveLength(1);

    compiler.dispose();
    runner.dispose();
  });

  it("attempts only one clean replacement after an initialized Worker crashes", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const first = workerState.compilers[0]!;
    respondToInitialization(first);
    await compiler.ready();

    dispatch(first, "error", { message: "runtime crash" });
    const replacement = workerState.compilers[1]!;
    const replacementReady = expect(compiler.ready()).rejects.toThrow("replacement load failed");
    dispatch(replacement, "error", { message: "replacement load failed" });
    await replacementReady;
    expect(workerState.compilers).toHaveLength(2);
    compiler.dispose();
  });

  it("rejects a running execution at once when the runner Worker is lost", async () => {
    vi.useFakeTimers();
    const runner = new BrowserRunner({ toolchains: TEST_TOOLCHAINS, additionalCostBaselines: { [TEST_COST_PROFILE]: 0 } });
    try {
      const worker = workerState.runners[0]!;
      respondToInitialization(worker);
      await runner.ready();
      const pending = runner.run(wasmArtifact(), runConfig());
      await Promise.resolve();
      const { requestId } = requestOfType(worker, "run");
      respond(worker, { type: "progress", requestId, progress: { phase: "running", label: "guest" } });
      await vi.advanceTimersByTimeAsync(10);

      lose(worker, "The wasm-oj-runner Worker stopped without reporting an error.");

      await expect(pending).rejects.toThrow("The wasm-oj-runner Worker stopped without reporting an error.");
      expect(worker.terminated).toBe(true);
      expect(workerState.runners).toHaveLength(2);
    } finally {
      runner.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects a build at once when the compiler Worker is lost", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();
    const pending = compiler.build(javascriptProject(), "cache-key");
    await vi.waitFor(() => expect(requestsOfType(worker, "build")).toHaveLength(1));

    lose(worker, "The wasm-oj-compiler Worker stopped without reporting an error.");

    await expect(pending).rejects.toThrow("The wasm-oj-compiler Worker stopped without reporting an error.");
    expect(worker.terminated).toBe(true);
    expect(workerState.compilers).toHaveLength(2);
    compiler.dispose();
  });

  it("rejects malformed direct compiler inputs before crossing the Worker boundary", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();
    const malformed = javascriptProject();
    malformed.config.args = [1] as unknown as string[];

    await expect(compiler.build(malformed, "cache-key")).rejects.toThrow("arguments must contain only strings");
    await expect(compiler.build(javascriptProject(), " ")).rejects.toThrow("cache keys must be non-empty");
    expect(requestsOfType(worker, "build")).toHaveLength(0);
    compiler.dispose();
  });

  it("retains the Rust Worker so consecutive builds share one Wasmer thread pool", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();

    const first = compiler.build(rustProject(), "rust-first");
    await until(() => requestsOfType(worker, "build").length === 1);
    respond(worker, {
      type: "build-result",
      requestId: requestOfTypeAt(worker, "build", 0).requestId,
      result: failedBuild(),
    });
    await expect(first).resolves.toEqual(failedBuild());

    const second = compiler.build(rustProject(), "rust-second");
    await until(() => requestsOfType(worker, "build").length === 2);
    respond(worker, {
      type: "build-result",
      requestId: requestOfTypeAt(worker, "build", 1).requestId,
      result: failedBuild(),
    });
    await expect(second).resolves.toEqual(failedBuild());
    expect(workerState.compilers).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    compiler.dispose();
  });

  it("retains the Go Worker so consecutive builds reuse verified toolchain bytes", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();

    for (let index = 0; index < 2; index += 1) {
      const pending = compiler.build(goProject(), `go-${index}`);
      await until(() => requestsOfType(worker, "build").length === index + 1);
      respond(worker, {
        type: "build-result",
        requestId: requestOfTypeAt(worker, "build", index).requestId,
        result: failedBuild(),
      });
      await expect(pending).resolves.toEqual(failedBuild());
    }

    expect(workerState.compilers).toHaveLength(1);
    expect(worker.terminated).toBe(false);
    compiler.dispose();
  });

  it("quiesces a retained Go stage before switching toolchain families", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const goWorker = workerState.compilers[0]!;
    respondToInitialization(goWorker);
    await compiler.ready();

    const goBuild = compiler.build(goProject(), "go");
    await until(() => requestsOfType(goWorker, "build").length === 1);
    respond(goWorker, {
      type: "build-result",
      requestId: requestOfType(goWorker, "build").requestId,
      result: failedBuild(),
    });
    await goBuild;

    const javascriptBuild = compiler.build(javascriptProject(), "javascript-after-go");
    await until(() => requestsOfType(goWorker, "quiesce").length === 1);
    respond(goWorker, {
      type: "quiesced",
      requestId: requestOfType(goWorker, "quiesce").requestId,
    });
    await until(() => workerState.compilers.length === 2);
    const javascriptWorker = workerState.compilers[1]!;
    respondToInitialization(javascriptWorker);
    await until(() => requestsOfType(javascriptWorker, "build").length === 1);
    respond(javascriptWorker, {
      type: "build-result",
      requestId: requestOfType(javascriptWorker, "build").requestId,
      result: failedBuild(),
    });

    await expect(javascriptBuild).resolves.toEqual(failedBuild());
    expect(goWorker.terminated).toBe(true);
    compiler.dispose();
  });

  it("recycles a warm Rust Worker before its third two-stage build", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const firstWorker = workerState.compilers[0]!;
    respondToInitialization(firstWorker);
    await compiler.ready();

    for (let index = 0; index < 2; index += 1) {
      const pending = compiler.build(rustProject(), `rust-${index}`);
      await until(() => requestsOfType(firstWorker, "build").length === index + 1);
      respond(firstWorker, {
        type: "build-result",
        requestId: requestOfTypeAt(firstWorker, "build", index).requestId,
        result: failedBuild(),
      });
      await expect(pending).resolves.toEqual(failedBuild());
    }

    const third = compiler.build(rustProject(), "rust-2");
    await until(() => requestsOfType(firstWorker, "quiesce").length === 1);
    expect(firstWorker.terminated).toBe(false);
    respond(firstWorker, {
      type: "quiesced",
      requestId: requestOfType(firstWorker, "quiesce").requestId,
    });
    await until(() => workerState.compilers.length === 2);
    expect(firstWorker.terminated).toBe(true);
    const replacement = workerState.compilers[1]!;
    respondToInitialization(replacement);
    await until(() => requestsOfType(replacement, "build").length === 1);
    respond(replacement, {
      type: "build-result",
      requestId: requestOfType(replacement, "build").requestId,
      result: failedBuild(),
    });

    await expect(third).resolves.toEqual(failedBuild());
    expect(workerState.compilers).toHaveLength(2);
    expect(replacement.terminated).toBe(false);
    compiler.dispose();
  });

  it("does not apply the generic 60-second timeout to a Rust build", async () => {
    vi.useFakeTimers();
    try {
      const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
      const worker = workerState.compilers[0]!;
      respondToInitialization(worker);
      await compiler.ready();

      const pending = compiler.build(rustProject(), "slow-rust");
      const assertion = expect(pending).rejects.toThrow(
        "request exceeded the 190000 ms browser boundary",
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(requestsOfType(worker, "build")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(worker.terminated).toBe(false);
      expect(workerState.compilers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(130_000);

      await assertion;
      expect(worker.terminated).toBe(true);
      expect(workerState.compilers).toHaveLength(2);
      compiler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recycles bounded compiler state when switching between toolchain families", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const rustWorker = workerState.compilers[0]!;
    respondToInitialization(rustWorker);
    await compiler.ready();

    const rustBuild = compiler.build(rustProject(), "rust");
    await until(() => requestsOfType(rustWorker, "build").length === 1);
    respond(rustWorker, {
      type: "build-result",
      requestId: requestOfType(rustWorker, "build").requestId,
      result: failedBuild(),
    });
    await rustBuild;

    const javascriptBuild = compiler.build(javascriptProject(), "javascript");
    await until(() => requestsOfType(rustWorker, "quiesce").length === 1);
    respond(rustWorker, {
      type: "quiesced",
      requestId: requestOfType(rustWorker, "quiesce").requestId,
    });
    await until(() => workerState.compilers.length === 2);
    expect(rustWorker.terminated).toBe(true);
    const javascriptWorker = workerState.compilers[1]!;
    respondToInitialization(javascriptWorker);
    await until(() => requestsOfType(javascriptWorker, "build").length === 1);
    respond(javascriptWorker, {
      type: "build-result",
      requestId: requestOfType(javascriptWorker, "build").requestId,
      result: failedBuild(),
    });
    await javascriptBuild;

    expect(javascriptWorker.terminated).toBe(true);
    expect(workerState.compilers).toHaveLength(3);
    compiler.dispose();
  });

  it("downloads the toolchain before the build boundary starts, once per profile", async () => {
    vi.useFakeTimers();
    try {
      let finishDownload!: () => void;
      prefetchBrowserToolchain.mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishDownload = resolve;
      }));
      const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
      const worker = workerState.compilers[0]!;
      respondToInitialization(worker);
      await compiler.ready();

      const first = compiler.build(rustProject(), "slow-network");
      await vi.advanceTimersByTimeAsync(200_000);
      expect(requestsOfType(worker, "build")).toHaveLength(0);
      expect(worker.terminated).toBe(false);
      expect(prefetchBrowserToolchain).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        language: "rust",
        target: "wasip1",
        optimization: "release",
        libcxxPrecompiledHeader: false,
      }));

      finishDownload();
      await vi.advanceTimersByTimeAsync(0);
      respond(worker, {
        type: "build-result",
        requestId: requestOfTypeAt(worker, "build", 0).requestId,
        result: failedBuild(),
      });
      await expect(first).resolves.toEqual(failedBuild());

      const second = compiler.build(rustProject(), "warm-network");
      await vi.advanceTimersByTimeAsync(0);
      respond(worker, {
        type: "build-result",
        requestId: requestOfTypeAt(worker, "build", 1).requestId,
        result: failedBuild(),
      });
      await expect(second).resolves.toEqual(failedBuild());
      expect(prefetchBrowserToolchain).toHaveBeenCalledTimes(1);
      compiler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a build whose toolchain download fails without crossing the Worker boundary", async () => {
    prefetchBrowserToolchain.mockRejectedValueOnce(new Error("Failed to fetch"));
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();

    await expect(compiler.build(rustProject(), "offline")).rejects.toThrow("Failed to fetch");
    expect(requestsOfType(worker, "build")).toHaveLength(0);
    expect(worker.terminated).toBe(false);

    const retry = compiler.build(rustProject(), "online");
    await until(() => requestsOfType(worker, "build").length === 1);
    respond(worker, {
      type: "build-result",
      requestId: requestOfType(worker, "build").requestId,
      result: failedBuild(),
    });
    await expect(retry).resolves.toEqual(failedBuild());
    expect(prefetchBrowserToolchain).toHaveBeenCalledTimes(2);
    compiler.dispose();
  });

  it("aborts an in-flight toolchain download when the build is cancelled", async () => {
    prefetchBrowserToolchain.mockImplementationOnce((_sources, options) => new Promise<void>((_resolve, reject) => {
      const { signal } = options as { signal: AbortSignal };
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const worker = workerState.compilers[0]!;
    respondToInitialization(worker);
    await compiler.ready();

    const pending = compiler.build(rustProject(), "cancelled-download");
    await until(() => prefetchBrowserToolchain.mock.calls.length === 1);
    const assertion = expect(pending).rejects.toThrow("cancelled");
    compiler.cancel();

    await assertion;
    expect(requestsOfType(worker, "build")).toHaveLength(0);
    compiler.dispose();
  });

  it("downloads the admitted libc++ PCH only for C++ projects that ship its exact header", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    respondToInitialization(workerState.compilers[0]!);
    await compiler.ready();

    void compiler.build(cppProject(WASM_OJ_LIBCXX_PCH_HEADER), "admitted-pch").catch(() => undefined);
    await until(() => prefetchBrowserToolchain.mock.calls.length === 1);
    expect(prefetchBrowserToolchain.mock.calls[0]![1]).toMatchObject({ language: "cpp", libcxxPrecompiledHeader: true });
    compiler.cancel();

    const replacement = workerState.compilers[1]!;
    void compiler.build(cppProject("#include <vector>\n"), "custom-pch").catch(() => undefined);
    respondToInitialization(replacement);
    await until(() => prefetchBrowserToolchain.mock.calls.length === 2);
    expect(prefetchBrowserToolchain.mock.calls[1]![1]).toMatchObject({ language: "cpp", libcxxPrecompiledHeader: false });
    compiler.dispose();
  });

  it("releases a cancelled compiler build before the stale promise settles", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const firstWorker = workerState.compilers[0]!;
    respondToInitialization(firstWorker);
    await compiler.ready();

    const stale = compiler.build(javascriptProject(), "stale");
    await until(() => requestsOfType(firstWorker, "build").length === 1);
    const staleAssertion = expect(stale).rejects.toThrow("cancelled");
    compiler.cancel();

    expect(firstWorker.terminated).toBe(true);
    const replacement = workerState.compilers[1]!;
    const retry = compiler.build(javascriptProject(), "retry");
    respondToInitialization(replacement);
    await until(() => requestsOfType(replacement, "build").length === 1);
    respond(replacement, {
      type: "build-result",
      requestId: requestOfType(replacement, "build").requestId,
      result: failedBuild(),
    });

    await staleAssertion;
    await expect(retry).resolves.toEqual(failedBuild());
    compiler.dispose();
  });

  it("ignores events from a terminated compiler Worker", async () => {
    const compiler = new BrowserCompiler({ toolchains: TEST_TOOLCHAINS });
    const firstWorker = workerState.compilers[0]!;
    respondToInitialization(firstWorker);
    await compiler.ready();
    const progress = vi.fn();
    compiler.onProgress(progress);

    compiler.restart();
    respond(firstWorker, {
      type: "progress",
      requestId: "stale",
      progress: { phase: "compiling", label: "stale", progress: 0.5 },
    });
    expect(progress).not.toHaveBeenCalled();
    compiler.dispose();
  });

  it("releases a cancelled runner execution and keeps stale Worker events isolated", async () => {
    const runner = new BrowserRunner({
      toolchains: TEST_TOOLCHAINS,
      additionalCostBaselines: { [TEST_COST_PROFILE]: 0 },
    });
    const firstWorker = workerState.runners[0]!;
    respondToInitialization(firstWorker);
    await runner.ready();
    const stream = vi.fn();
    runner.onStream(stream);

    const stale = runner.run(wasmArtifact(), runConfig());
    await until(() => requestsOfType(firstWorker, "run").length === 1);
    const staleAssertion = expect(stale).rejects.toThrow("cancelled");
    runner.cancel();

    const replacement = workerState.runners[1]!;
    const retry = runner.run(wasmArtifact(), runConfig());
    respond(firstWorker, { type: "stream", requestId: "stale", stream: "stdout", chunk: "stale" });
    respondToInitialization(replacement);
    await until(() => requestsOfType(replacement, "run").length === 1);
    const result = successfulRun();
    respond(replacement, {
      type: "run-result",
      requestId: requestOfType(replacement, "run").requestId,
      result,
    });

    await staleAssertion;
    await expect(retry).resolves.toEqual(result);
    expect(stream).not.toHaveBeenCalledWith("stdout", "stale");
    runner.dispose();
  });

  it("rejects concurrent browser operations without disturbing the accepted run", async () => {
    const runner = new BrowserRunner({
      toolchains: TEST_TOOLCHAINS,
      additionalCostBaselines: { [TEST_COST_PROFILE]: 0 },
    });
    const worker = workerState.runners[0]!;
    respondToInitialization(worker);
    await runner.ready();

    const accepted = runner.run(wasmArtifact(), runConfig());
    await until(() => requestsOfType(worker, "run").length === 1);
    await expect(runner.run(wasmArtifact(), runConfig())).rejects.toThrow("one active operation");
    await expect(runner.clearRuntimeCache()).rejects.toThrow("one active operation");

    const result = successfulRun();
    respond(worker, {
      type: "run-result",
      requestId: requestOfType(worker, "run").requestId,
      result,
    });
    await expect(accepted).resolves.toEqual(result);
    runner.dispose();
  });

  it("terminates a run whose runtime preparation never reaches the guest boundary", async () => {
    vi.useFakeTimers();
    try {
      const runner = new BrowserRunner({
        toolchains: TEST_TOOLCHAINS,
        additionalCostBaselines: { [TEST_COST_PROFILE]: 0 },
      });
      const worker = workerState.runners[0]!;
      respondToInitialization(worker);
      await runner.ready();

      const pending = runner.run(wasmArtifact(), runConfig());
      const assertion = expect(pending).rejects.toThrow(
        "runtime preparation exceeded the 120000 ms browser boundary",
      );
      await Promise.resolve();
      expect(requestsOfType(worker, "run")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);

      await assertion;
      expect(worker.terminated).toBe(true);
      expect(workerState.runners).toHaveLength(2);
      runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the user wall-time budget only when runtime preparation reaches the guest", async () => {
    vi.useFakeTimers();
    try {
      const runner = new BrowserRunner({
        toolchains: TEST_TOOLCHAINS,
        additionalCostBaselines: { [TEST_COST_PROFILE]: 0 },
      });
      const worker = workerState.runners[0]!;
      respondToInitialization(worker);
      await runner.ready();
      const config = runConfig();
      config.resources = { ...config.resources, wallTimeLimitMs: 25 };

      const pending = runner.run(wasmArtifact(), config);
      await Promise.resolve();
      const request = requestOfType(worker, "run");
      await vi.advanceTimersByTimeAsync(119_999);
      respond(worker, {
        type: "progress",
        requestId: request.requestId,
        progress: { phase: "running", label: "guest started", progress: 0.25 },
      });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toMatchObject({
        termination: "wall-time-limit",
        resources: { wallTimeLimitMs: 25 },
        executionDurationMs: 25,
      });
      expect(worker.terminated).toBe(true);
      runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("excludes result collection from a completed guest's wall budget", async () => {
    vi.useFakeTimers();
    const runner = new BrowserRunner({ toolchains: TEST_TOOLCHAINS, additionalCostBaselines: { [TEST_COST_PROFILE]: 0 } });
    try {
      const worker = workerState.runners[0]!;
      respondToInitialization(worker);
      await runner.ready();
      const config = runConfig();
      config.resources = { ...config.resources, wallTimeLimitMs: 25 };
      const pending = runner.run(wasmArtifact(), config);
      await Promise.resolve();
      const { requestId } = requestOfType(worker, "run");
      respond(worker, { type: "progress", requestId, progress: { phase: "running", label: "guest" } });
      await vi.advanceTimersByTimeAsync(10);
      respond(worker, { type: "progress", requestId, progress: { phase: "packaging", label: "collect results" } });
      await vi.advanceTimersByTimeAsync(100);
      expect(worker.terminated).toBe(false);
      const result = { ...successfulRun(), executionDurationMs: 10, durationMs: 110 };
      respond(worker, { type: "run-result", requestId, result });
      await expect(pending).resolves.toEqual(result);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(workerState.runners).toHaveLength(1);
    } finally {
      runner.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds stalled result collection as a system failure and replaces its worker", async () => {
    vi.useFakeTimers();
    const runner = new BrowserRunner({ toolchains: TEST_TOOLCHAINS, additionalCostBaselines: { [TEST_COST_PROFILE]: 0 } });
    try {
      const worker = workerState.runners[0]!;
      respondToInitialization(worker);
      await runner.ready();
      const config = runConfig();
      config.resources = { ...config.resources, wallTimeLimitMs: 25 };
      const pending = runner.run(wasmArtifact(), config);
      const assertion = expect(pending).rejects.toThrow("result collection exceeded the 120000 ms browser boundary");
      await Promise.resolve();
      const { requestId } = requestOfType(worker, "run");
      respond(worker, { type: "progress", requestId, progress: { phase: "running", label: "guest" } });
      await vi.advanceTimersByTimeAsync(10);
      respond(worker, { type: "progress", requestId, progress: { phase: "packaging", label: "collect results" } });
      await vi.advanceTimersByTimeAsync(60_000);
      // Duplicate progress must not restart either deadline after execution ends.
      respond(worker, { type: "progress", requestId, progress: { phase: "running", label: "duplicate" } });
      respond(worker, { type: "progress", requestId, progress: { phase: "packaging", label: "duplicate" } });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(worker.terminated).toBe(true);
      expect(workerState.runners).toHaveLength(2);
      const replacement = workerState.runners[1]!;
      respondToInitialization(replacement);
      await runner.ready();
      const retry = runner.run(wasmArtifact(), config);
      await Promise.resolve();
      const result = successfulRun();
      respond(replacement, { type: "run-result", requestId: requestOfType(replacement, "run").requestId, result });
      await expect(retry).resolves.toEqual(result);
    } finally {
      runner.dispose();
      vi.useRealTimers();
    }
  });

});

function respondToInitialization(worker: FakeWorker): void {
  const request = requestOfType(worker, "initialize");
  respond(worker, { type: "ready", requestId: request.requestId });
}

function dispatch(worker: FakeWorker, type: string, event: unknown): void {
  for (const listener of worker.listeners.get(type) ?? []) listener(event);
}

function lose(worker: FakeWorker, message: string): void {
  for (const listener of worker.lostListeners) listener(new Error(message));
}

function respond(worker: FakeWorker, data: unknown): void {
  for (const listener of worker.listeners.get("message") ?? []) listener({ data });
}

function requestsOfType(worker: FakeWorker, type: string): Array<Record<string, unknown>> {
  return worker.messages.filter(
    (message): message is Record<string, unknown> => (
      typeof message === "object" && message !== null && (message as Record<string, unknown>).type === type
    ),
  );
}

function requestOfType(worker: FakeWorker, type: string): Record<string, string> {
  return requestOfTypeAt(worker, type, 0);
}

function requestOfTypeAt(worker: FakeWorker, type: string, index: number): Record<string, string> {
  const request = requestsOfType(worker, type)[index];
  if (!request || typeof request.requestId !== "string") throw new Error(`Missing '${type}' Worker request.`);
  return request as Record<string, string>;
}

function javascriptProject(): Project {
  return {
    id: "project",
    name: "project",
    files: [{ path: "main.js", language: "javascript", content: "" }],
    activeFile: "main.js",
    updatedAt: 0,
    config: {
      language: "javascript",
      target: "wasip1",
      optimization: "release",
      entry: "main.js",
      args: [],
      stdin: "",
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
  };
}

function rustProject(): Project {
  const base = javascriptProject();
  return {
    ...base,
    files: [{ path: "main.rs", language: "rust", content: "fn main() {}" }],
    activeFile: "main.rs",
    config: {
      ...base.config,
      language: "rust",
      entry: "main.rs",
    },
  };
}

function cppProject(pchHeader: string): Project {
  const base = javascriptProject();
  return {
    ...base,
    files: [
      { path: "main.cpp", language: "cpp", content: "int main() {}\n" },
      { path: "wasm-oj.pch.hpp", language: "cpp", content: pchHeader },
    ],
    activeFile: "main.cpp",
    config: {
      ...base.config,
      language: "cpp",
      entry: "main.cpp",
    },
  };
}

function goProject(): Project {
  const base = javascriptProject();
  return {
    ...base,
    files: [{ path: "main.go", language: "go", content: "package main\nfunc main() {}\n" }],
    activeFile: "main.go",
    config: {
      ...base.config,
      language: "go",
      entry: "main.go",
    },
  };
}

function failedBuild(): BuildResult {
  return {
    success: false,
    diagnostics: [],
    stdout: "",
    stderr: "compile error",
    cacheHit: false,
  };
}

function wasmArtifact(): BuildArtifact {
  return {
    kind: "wasm",
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    id: "artifact",
    projectId: "project",
    cacheKey: "cache",
    name: "project.wasm",
    language: "zig",
    target: "wasip1",
    optimization: "release",
    createdAt: 0,
    durationMs: 0,
    size: 8,
    toolchains: ["zig-test-toolchain"],
    costProfile: TEST_COST_PROFILE,
    bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  };
}

function runConfig(): RunConfig {
  return {
    args: [],
    stdin: "",
    env: {},
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
  };
}

function successfulRun(): RunResult {
  return {
    code: 0,
    stdout: "ok\n",
    stderr: "",
    files: {},
    durationMs: 1,
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
    termination: "exited",
    metrics: {
      cost: 1,
      rawCost: 1,
      baselineCost: 0,
      costProfile: TEST_COST_PROFILE,
      costModel: WEIGHTED_METER_MODEL,
      operations: { I32Const: 1 },
      memoryBytes: 65_536,
      logicalTimeNs: 0,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: 3,
      stderrBytes: 0,
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
