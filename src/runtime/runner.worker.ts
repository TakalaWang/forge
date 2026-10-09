/// <reference lib="webworker" />

import { Runtime, Wasmer, init } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import { WASM_OJ_STORAGE } from "@/src/core/contract";
import { sha256Hex } from "@/src/core/hash";
import {
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
  QUICKJS_VERSION,
} from "@/src/core/toolchains";
import {
  browserToolchainAssetUrl,
  snapshotBrowserToolchainSources,
  toolchainAssetSource,
} from "@/src/core/toolchain-sources";
import type {
  BrowserToolchainSource,
  ExecutionTermination,
  InteractiveProcessResult,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunnerRequest,
  RunnerResponse,
  RunResult,
  WorkerPhase,
} from "@/src/core/types";
import {
  createExtendedCostBaselineRegistry,
  normalizeExecutionMetrics,
  type RawExecutionMetrics,
} from "@/src/core/cost";
import {
  prepareArtifactRun,
  prepareArtifactInteraction,
  createDefaultRuntimeDrivers,
  type PackageFileSystemRequest,
  type RuntimeDriverRegistry,
  type RuntimeResolver,
} from "@/src/runner/artifact";
import {
  openOptionalRuntimeFilesCache,
  restoreOrExportRuntimeFiles,
} from "@/src/runtime/runtime-files-cache";
import { readRuntimeFilesExport } from "@/src/runner/runtime-files";
import {
  PackageHandleCache,
  WasmerPackageHandle,
  withHandleLease,
  withWasmerCommand,
} from "@/src/runner/package-handle-cache";
import initRuntimeCore, { run_wasm_oj as runWasmOjCore } from "@/src/runner/generated/runtime-core.js";
import runtimeCoreWasmUrl from "@/src/runner/generated/runtime-core_bg.wasm?url";
import {
  createModuleWorker,
  createModuleWorkerBootstrap,
  type ModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
} from "./module-worker";
import { createInteractivePipe, interactivePipeCapacity } from "./interactive-pipe";
import type { InteractiveSideMessage, InteractiveSideStart } from "./interactive-side.worker";
import interactiveSideWorkerUrl from "./interactive-side.worker?worker&url";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";
import { OwnedWorkerRegistry, type WorkerConstructorHost } from "./owned-worker-registry";
import { loadBrowserRuntimeDriverPlugins } from "./browser-runtime-plugin";
import type { BrowserRuntimeDriverPlugin } from "@/src/core/types";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
const decoder = new TextDecoder();
const packages = new PackageHandleCache<string, WasmerPackageHandle>();
const packageFileSystems = new Map<string, Promise<Record<string, Uint8Array>>>();
let sdkRuntime: Runtime | undefined;
let sdkRuntimeInitialization: Promise<Runtime> | undefined;
let wasmerThreadWorkerBootstrap: ModuleWorkerBootstrap | undefined;
const wasmerThreadWorkers = new OwnedWorkerRegistry(globalThis as unknown as WorkerConstructorHost, {
  owns: (scriptUrl) => scriptUrl === wasmerThreadWorkerBootstrap?.url,
});
let wasmerThreadWorkersInstalled = false;
let runtimeDrivers: RuntimeDriverRegistry | undefined;
let quickJsBytes: Promise<Uint8Array> | undefined;
let toolchainSources: readonly BrowserToolchainSource[] | undefined;
let runtimeCoreModule: WebAssembly.Module | undefined;

interface CoreRunResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  files: Record<string, Uint8Array>;
  termination: ExecutionTermination;
  trapMessage?: string;
  metrics: {
    cost: number | bigint;
    costModel: string;
    operations: Record<string, number | bigint>;
    memoryBytes: number | bigint;
    logicalTimeNs: number | bigint;
    filesystemBytes: number | bigint;
    filesystemEntries: number | bigint;
    stdoutBytes: number | bigint;
    stderrBytes: number | bigint;
  };
}

interface CoreRunResponse {
  ok: boolean;
  result?: CoreRunResult;
  error?: { code: string; message: string };
}

interface CoreInteractiveProcessResult {
  code: number;
  stderr: Uint8Array;
  termination: ExecutionTermination;
  metrics: {
    cost: number | bigint;
    operations: Record<string, number | bigint>;
    logicalTimeNs: number | bigint;
    filesystemBytes: number | bigint;
    filesystemEntries: number | bigint;
    protocolBytes: number | bigint;
    stderrBytes: number | bigint;
  };
}

interface CoreInteractiveSideResponse {
  ok: boolean;
  result?: {
    process: CoreInteractiveProcessResult;
    protocol: Uint8Array;
  };
  error?: { code: string; message: string };
}

function post(response: RunnerResponse): void {
  scope.postMessage(response);
}

function progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void {
  post({ type: "progress", requestId, progress: { phase, label, progress: value } });
}

async function initializeRuntime(
  requestId: string,
  sources: readonly BrowserToolchainSource[],
  additionalCostBaselines?: Readonly<Record<string, number>>,
  runtimeDriverPlugins: readonly BrowserRuntimeDriverPlugin[] = [],
): Promise<void> {
  if (!crossOriginIsolated) {
    throw new Error("The deterministic runner requires a cross-origin-isolated page with COOP and COEP headers.");
  }
  toolchainSources = snapshotBrowserToolchainSources(sources);

  progress(requestId, "initializing", "Starting deterministic Wasmer runner", 0.1);
  runtimeCoreModule = await compileRuntimeCore();
  await initRuntimeCore({ module_or_path: runtimeCoreModule });
  runtimeDrivers = createDefaultRuntimeDrivers(
    createExtendedCostBaselineRegistry(additionalCostBaselines),
  );
  if (runtimeDriverPlugins.length > 0) {
    progress(requestId, "initializing", "Loading pinned runtime-driver plug-ins", 0.85);
    for (const driver of await loadBrowserRuntimeDriverPlugins(runtimeDriverPlugins, workerBaseUrl.href)) {
      runtimeDrivers.register(driver);
    }
  }
  progress(requestId, "initializing", "Deterministic Wasmer runner ready", 1);
}

async function compileRuntimeCore(): Promise<WebAssembly.Module> {
  const response = await fetch(new URL(runtimeCoreWasmUrl, workerBaseUrl));
  if (!response.ok) throw new Error(`Unable to load the WASM-OJ runtime core (${response.status}).`);
  return response.headers.get("Content-Type")?.startsWith("application/wasm")
    ? WebAssembly.compileStreaming(response)
    : WebAssembly.compile(await response.arrayBuffer());
}

async function ensurePackageRuntime(): Promise<Runtime> {
  if (sdkRuntime) return sdkRuntime;
  sdkRuntimeInitialization ??= (async () => {
    const bootstrap = createModuleWorkerBootstrap(new URL(wasmerThreadWorkerUrl, workerBaseUrl));
    wasmerThreadWorkerBootstrap = bootstrap;
    try {
      if (!wasmerThreadWorkersInstalled) {
        wasmerThreadWorkers.install();
        wasmerThreadWorkersInstalled = true;
      }
      await init({
        log: "warn",
        module: new URL(wasmerWasmUrl, workerBaseUrl),
        workerUrl: bootstrap.url,
      });
      const initialized = new Runtime({ registry: null });
      sdkRuntime = initialized;
      return initialized;
    } catch (error) {
      if (wasmerThreadWorkerBootstrap === bootstrap) wasmerThreadWorkerBootstrap = undefined;
      bootstrap.revoke();
      throw error;
    }
  })();
  try {
    return await sdkRuntimeInitialization;
  } catch (error) {
    sdkRuntimeInitialization = undefined;
    throw error;
  }
}

function toolchainAssetUrl(path: string): URL {
  if (!toolchainSources) throw new Error("The runner toolchain-source registry is not initialized.");
  return browserToolchainAssetUrl(toolchainSources, path, workerBaseUrl);
}

async function loadCompressedAsset(
  path: string,
  label: string,
  compressedSha256: string,
  expandedSha256?: string,
): Promise<Uint8Array> {
  const response = await fetch(toolchainAssetUrl(path));
  if (!response.ok) {
    throw new Error(`Unable to load ${label} (${response.status}).`);
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  if (!toolchainSources) throw new Error("The runner toolchain-source registry is not initialized.");
  const { asset } = toolchainAssetSource(toolchainSources, path);
  if (compressed.byteLength !== asset.bytes) {
    throw new Error(`Pinned ${label} asset has ${compressed.byteLength} bytes; expected ${asset.bytes}.`);
  }
  if (asset.sha256 !== compressedSha256) {
    throw new Error(`Pinned ${label} descriptor digest ${asset.sha256} does not match runtime pin ${compressedSha256}.`);
  }
  const actual = await sha256Hex(compressed);
  if (actual !== compressedSha256) {
    throw new Error(`Pinned ${label} asset has digest ${actual}; expected ${compressedSha256}.`);
  }
  const body = new Response(compressed).body;
  if (!body) throw new Error(`Pinned ${label} asset '${path}' has no response body.`);
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  if (expandedSha256) {
    const expandedDigest = await sha256Hex(bytes);
    if (expandedDigest !== expandedSha256) {
      throw new Error(`Pinned ${label} payload has digest ${expandedDigest}; expected ${expandedSha256}.`);
    }
  }
  return bytes;
}

function acquirePackage(specifier: string) {
  if (specifier !== PYTHON_PACKAGE) {
    throw new Error(`No pinned WASM-OJ runtime package is declared for '${specifier}'.`);
  }
  return packages.acquire(specifier, async () => {
    const [bytes, runtime] = await Promise.all([
      loadCompressedAsset(
        PYTHON_PACKAGE_ASSET_PATH,
        "Python/WASI package",
        PYTHON_COMPRESSED_PACKAGE_SHA256,
        PYTHON_PACKAGE_SHA256,
      ),
      ensurePackageRuntime(),
    ]);
    return new WasmerPackageHandle(await Wasmer.fromFile(bytes, runtime));
  });
}

function runtimeFilesCacheRequest(request: PackageFileSystemRequest): Request {
  const identity = `${request.packageSpecifier}\n${request.command}\n${request.cacheKey}\n${request.expectedSha256}`;
  const encoded = encodeURIComponent(identity);
  return new Request(new URL(`/__wasm_oj_runtime_files__/${encoded}`, workerBaseUrl));
}

async function exportPackageFileSystem(
  request: PackageFileSystemRequest,
): Promise<Record<string, Uint8Array>> {
  const key = `${request.packageSpecifier}\n${request.command}\n${request.cacheKey}\n${request.expectedSha256}`;
  let pending = packageFileSystems.get(key);
  if (pending) return pending;

  pending = (async () => {
    const cache = await openOptionalRuntimeFilesCache(caches, WASM_OJ_STORAGE.runtimeFilesCache);
    const cacheRequest = runtimeFilesCacheRequest(request);
    return restoreOrExportRuntimeFiles(
      cache,
      {
        cacheRequest,
        cacheKey: request.cacheKey,
        expectedSha256: request.expectedSha256,
      },
      async () => {
        const lease = await acquirePackage(request.packageSpecifier);
        return withHandleLease(
          lease,
          (pkg) => withWasmerCommand(pkg, request.command, async (command) => {
            const instance = await command.run({
              args: request.args,
              env: {
                PYTHONHOME: "/usr/local",
                PYTHONHASHSEED: "0",
                PYTHONDONTWRITEBYTECODE: "1",
              },
            });
            try {
              return await readRuntimeFilesExport(instance);
            } catch (error) {
              throw new Error(
                `Unable to export runtime files from ${request.packageSpecifier}: ${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              instance.free();
            }
          }),
        );
      },
    );
  })();
  packageFileSystems.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (packageFileSystems.get(key) === pending) packageFileSystems.delete(key);
    throw error;
  }
}

function loadQuickJs(): Promise<Uint8Array> {
  const cached = quickJsBytes;
  if (cached) return cached;
  const pending = loadCompressedAsset(
    QUICKJS_ASSET_PATH,
    `the pinned QuickJS-ng ${QUICKJS_VERSION}/WASI runtime`,
    QUICKJS_ASSET_SHA256,
  );
  quickJsBytes = pending;
  void pending.catch(() => {
    if (quickJsBytes === pending) quickJsBytes = undefined;
  });
  return pending;
}

const resolver: RuntimeResolver = {
  quickJs() {
    return loadQuickJs();
  },
  async packageCommand(packageSpecifier, commandName) {
    const lease = await acquirePackage(packageSpecifier);
    return withHandleLease(
      lease,
      (pkg) => withWasmerCommand(pkg, commandName, (command) => command.binary()),
    );
  },
  packageFileSystem: exportPackageFileSystem,
};

async function clearRuntimeCaches(): Promise<void> {
  const packageRetirement = packages.retireAll();
  packageFileSystems.clear();
  quickJsBytes = undefined;
  await packageRetirement.wait();
  await caches.delete(WASM_OJ_STORAGE.runtimeFilesCache);
}

function number(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`Runner returned an invalid numeric metric: ${String(value)}.`);
  }
  return converted;
}

function rawMetrics(value: CoreRunResult["metrics"]): RawExecutionMetrics {
  return {
    cost: number(value.cost),
    costModel: value.costModel,
    operations: Object.fromEntries(
      Object.entries(value.operations).map(([opcode, count]) => [opcode, number(count)]),
    ),
    memoryBytes: number(value.memoryBytes),
    logicalTimeNs: number(value.logicalTimeNs),
    filesystemBytes: number(value.filesystemBytes),
    filesystemEntries: number(value.filesystemEntries),
    stdoutBytes: number(value.stdoutBytes),
    stderrBytes: number(value.stderrBytes),
  };
}

async function runArtifact(request: Extract<RunnerRequest, { type: "run" }>): Promise<RunResult> {
  const started = performance.now();
  progress(request.requestId, "loading-toolchain", `Resolving runtime for ${request.artifact.name}`, 0.1);
  if (!runtimeDrivers) throw new Error("The WASM-OJ runtime-driver registry is not initialized.");
  const prepared = await prepareArtifactRun(request.artifact, request.config, resolver, runtimeDrivers);
  let executionStarted = 0;
  let executionDurationMs = 0;
  const response = runWasmOjCore(prepared, (running: boolean) => {
    if (running) {
      progress(request.requestId, "running", `Running ${request.artifact.name} with deterministic Wasmer`, 0.25);
      executionStarted = performance.now();
    } else {
      executionDurationMs = performance.now() - executionStarted;
      progress(request.requestId, "packaging", "Collecting execution results", 0.9);
    }
  }) as CoreRunResponse;
  if (!response.ok || !response.result) {
    const error = response.error ?? { code: "RUNTIME_ERROR", message: "The runtime core returned no result." };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  const stdout = decoder.decode(response.result.stdout);
  const stderr = decoder.decode(response.result.stderr);
  if (stdout) post({ type: "stream", requestId: request.requestId, stream: "stdout", chunk: stdout });
  if (stderr) post({ type: "stream", requestId: request.requestId, stream: "stderr", chunk: stderr });
  return {
    code: response.result.code,
    stdout,
    stderr,
    files: Object.fromEntries(Object.entries(response.result.files).map(([path, contents]) => [path, contents.slice()])),
    durationMs: performance.now() - started,
    executionDurationMs,
    determinism: { ...request.config.determinism },
    resources: { ...request.config.resources },
    termination: response.result.termination,
    trapMessage: response.result.trapMessage,
    metrics: normalizeExecutionMetrics(rawMetrics(response.result.metrics), prepared.cost),
  };
}

async function interactArtifacts(
  request: Extract<RunnerRequest, { type: "interact" }>,
): Promise<InteractiveRunResult> {
  const started = performance.now();
  if (!runtimeDrivers) throw new Error("The WASM-OJ runtime-driver registry is not initialized.");
  progress(request.requestId, "loading-toolchain", "Resolving contestant and interactor runtimes", 0.1);
  const [contestant, interactor] = await Promise.all([
    prepareArtifactInteraction(
      request.contestant,
      interactiveRunConfig(request.config.contestant, request.config.determinism),
      resolver,
      runtimeDrivers,
    ),
    prepareArtifactInteraction(
      request.interactor,
      interactiveRunConfig(request.config.interactor, request.config.determinism),
      resolver,
      runtimeDrivers,
    ),
  ]);
  const [contestantSide, interactorSide] = await runInteractiveSides(
    request.requestId,
    { contestant: interactiveCoreProgram(contestant), interactor: interactiveCoreProgram(interactor) },
    request.config.determinism,
  );
  return {
    contestant: interactiveProcessResult(contestantSide.process, contestant),
    interactor: interactiveProcessResult(interactorSide.process, interactor),
    contestantToInteractor: decoder.decode(contestantSide.protocol),
    interactorToContestant: decoder.decode(interactorSide.protocol),
    durationMs: performance.now() - started,
    determinism: { ...request.config.determinism },
  };
}

type InteractiveRole = "contestant" | "interactor";
type CoreInteractiveSide = NonNullable<CoreInteractiveSideResponse["result"]>;

async function runInteractiveSides(
  requestId: string,
  programs: Record<InteractiveRole, ReturnType<typeof interactiveCoreProgram>>,
  determinism: InteractiveRunConfig["determinism"],
): Promise<[CoreInteractiveSide, CoreInteractiveSide]> {
  if (!runtimeCoreModule) throw new Error("The WASM-OJ runtime core is not initialized.");
  const contestantToInteractor = createInteractivePipe(interactivePipeCapacity(programs.contestant.resources.outputLimitBytes));
  const interactorToContestant = createInteractivePipe(interactivePipeCapacity(programs.interactor.resources.outputLimitBytes));
  const sides: ReturnType<typeof startInteractiveSide>[] = [];
  try {
    sides.push(startInteractiveSide("contestant", {
      runtimeCore: runtimeCoreModule,
      request: { program: programs.contestant, determinism },
      input: interactorToContestant,
      output: contestantToInteractor,
    }));
    sides.push(startInteractiveSide("interactor", {
      runtimeCore: runtimeCoreModule,
      request: { program: programs.interactor, determinism },
      input: contestantToInteractor,
      output: interactorToContestant,
    }));
    void Promise.all(sides.map((side) => side.running)).then(() => {
      progress(requestId, "running", "Running interactive session with deterministic Wasmer", 0.25);
    });
    const results = await Promise.all(sides.map((side) => side.result));
    progress(requestId, "packaging", "Collecting interactive results", 0.9);
    return [results[0], results[1]];
  } finally {
    for (const side of sides) side.worker.terminate();
  }
}

function startInteractiveSide(role: InteractiveRole, start: InteractiveSideStart) {
  const worker = createModuleWorker(new URL(interactiveSideWorkerUrl, workerBaseUrl), {
    name: `wasm-oj-interactive-${role}`,
  });
  let markRunning!: () => void;
  const running = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  const result = new Promise<CoreInteractiveSide>((resolve, reject) => {
    worker.addEventListener("message", (event: MessageEvent<InteractiveSideMessage>) => {
      const message = event.data;
      if (message.type === "running") {
        markRunning();
      } else if (message.type === "error") {
        reject(Object.assign(new Error(`Interactive ${role} failed: ${message.message}`), { code: "RUNTIME_ERROR" }));
      } else {
        const response = message.response as CoreInteractiveSideResponse;
        if (response.ok && response.result) {
          resolve(response.result);
        } else {
          const error = response.error ?? { code: "RUNTIME_ERROR", message: "the runtime returned no result." };
          reject(Object.assign(new Error(`Interactive ${role} failed: ${error.message}`), { code: error.code }));
        }
      }
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      reject(Object.assign(new Error(`The interactive ${role} Worker crashed${event.message ? `: ${event.message}` : "."}`), { code: "RUNTIME_ERROR" }));
    });
  });
  try {
    worker.postMessage(start);
  } catch (error) {
    worker.terminate();
    throw error;
  }
  return { worker, running, result };
}

function interactiveRunConfig(
  program: InteractiveRunConfig["contestant"],
  determinism: InteractiveRunConfig["determinism"],
) {
  return {
    args: [...program.args],
    stdin: "",
    env: { ...program.env },
    files: Object.fromEntries(Object.entries(program.files ?? {}).map(([path, contents]) => [path, contents.slice()])),
    outputPaths: [],
    ...(program.cwd === undefined ? {} : { cwd: program.cwd }),
    determinism: { ...determinism },
    resources: { ...program.resources },
  };
}

function interactiveCoreProgram(prepared: Awaited<ReturnType<typeof prepareArtifactRun>>) {
  return {
    wasm: prepared.wasm,
    args: prepared.args,
    env: prepared.env,
    files: prepared.files,
    cwd: prepared.cwd,
    startupEntropyBytes: prepared.startupEntropyBytes,
    resources: prepared.resources,
  };
}

function interactiveProcessResult(
  result: CoreInteractiveProcessResult,
  prepared: Awaited<ReturnType<typeof prepareArtifactRun>>,
): InteractiveProcessResult {
  const metrics = normalizeExecutionMetrics({
    cost: number(result.metrics.cost),
    costModel: "weighted",
    operations: Object.fromEntries(
      Object.entries(result.metrics.operations).map(([opcode, count]) => [opcode, number(count)]),
    ),
    memoryBytes: 0,
    logicalTimeNs: number(result.metrics.logicalTimeNs),
    filesystemBytes: number(result.metrics.filesystemBytes),
    filesystemEntries: number(result.metrics.filesystemEntries),
    stdoutBytes: number(result.metrics.protocolBytes),
    stderrBytes: number(result.metrics.stderrBytes),
  }, prepared.cost);
  return {
    code: result.code,
    stderr: decoder.decode(result.stderr),
    termination: result.termination,
    metrics: { ...metrics, memoryBytes: null },
  };
}

scope.addEventListener("message", (event: MessageEvent<RunnerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case "initialize":
          await initializeRuntime(
            request.requestId,
            request.toolchains,
            request.additionalCostBaselines,
            request.runtimeDriverPlugins,
          );
          post({ type: "ready", requestId: request.requestId });
          break;
        case "run":
          post({
            type: "run-result",
            requestId: request.requestId,
            result: await wasmerThreadWorkers.run(() => runArtifact(request)),
          });
          break;
        case "interact":
          post({
            type: "interactive-result",
            requestId: request.requestId,
            result: await wasmerThreadWorkers.run(() => interactArtifacts(request)),
          });
          break;
        case "clear-runtime-cache":
          await wasmerThreadWorkers.run(() => clearRuntimeCaches());
          post({ type: "runtime-cache-cleared", requestId: request.requestId });
          break;
      }
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      const code = typeof (caught as Error & { code?: unknown }).code === "string"
        ? (caught as Error & { code: string }).code
        : "RUNNER_ERROR";
      post({ type: "error", requestId: request.requestId, code, message: caught.message, stack: caught.stack });
    }
  })();
});

export {};
