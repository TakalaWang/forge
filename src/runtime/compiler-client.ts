import {
  assertCompilerCacheKey,
  assertValidProject,
  isToolchainLibcxxPchHeader,
  snapshotBrowserToolchainSources,
  toolchainCacheIdentity,
  toolchainProfileSource,
  WASM_OJ_STORAGE,
} from "@wasm-oj/core";
import type {
  BuildResult,
  Compiler,
  CompilerRequest,
  CompilerResponse,
  CompilerTraceEvent,
  BrowserToolchainSource,
  Project,
  WorkerProgress,
} from "@wasm-oj/core";
import {
  MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER,
  assertOutputReadyClangStageBudget,
  observedOutputReadyClangStages,
  usesOutputReadyClang,
} from "../compiler/browser-clang-policy";
import { buildControlTimeoutMs } from "../compiler/build-timeout-policy";
import {
  MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER,
  maximumOutputReadyRustStages,
} from "../compiler/browser-rust-policy";
import CompilerWorkerUrl from "./compiler.worker?worker&url";
import { createModuleWorker, onModuleWorkerLost } from "./module-worker";
import { prefetchBrowserToolchain } from "./toolchain-prefetch";
import { clearClangBuildGraphCache } from "../compiler/indexeddb-build-graph-cache";

type ProgressListener = (progress: WorkerProgress) => void;
type TraceListener = (requestId: string, event: CompilerTraceEvent) => void;

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

interface CompilerOperation {
  kind: "build" | "cache-clear";
}

const CONTROL_TIMEOUT_MS = 120_000;
const QUIESCE_TIMEOUT_MS = 10_000;

export interface BrowserCompilerOptions {
  /** Explicit, contract-validated browser toolchain packages. */
  toolchains: readonly BrowserToolchainSource[];
}

type CompilerRequestWithoutId = CompilerRequest extends infer Request
  ? Request extends CompilerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export class BrowserCompiler implements Compiler {
  private worker: Worker;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly traceListeners = new Set<TraceListener>();
  private readyPromise: Promise<void>;
  private readonly toolchains: readonly BrowserToolchainSource[];
  private activeOperation: CompilerOperation | undefined;
  private disposed = false;
  private generation = 0;
  private workerDormant = false;
  private workerInitialized = false;
  private outputReadyClangStages = 0;
  private outputReadyRustStages = 0;
  private retainedGoStage = false;
  private readonly acquiredToolchains = new Set<string>();
  private acquisition: AbortController | undefined;

  constructor(options: BrowserCompilerOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("BrowserCompiler requires explicit toolchain options.");
    }
    this.toolchains = snapshotBrowserToolchainSources(options.toolchains);
    this.worker = this.createWorker();
    this.readyPromise = this.initializeWorker();
  }

  cacheIdentity(project: Project): string {
    this.assertActive();
    const { descriptor } = toolchainProfileSource(
      this.toolchains,
      project.config.language,
      project.config.target,
      project.config.optimization,
    ).source;
    return JSON.stringify({
      ...toolchainCacheIdentity(project.config.language),
      source: {
        id: descriptor.id,
        version: descriptor.version,
        assets: descriptor.assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      },
    });
  }

  private initializeWorker(): Promise<void> {
    const ready = this.request<void>({
      type: "initialize",
      toolchains: this.toolchains,
    }, CONTROL_TIMEOUT_MS);
    // A replacement Worker is initialized eagerly so the next edit/build can
    // start immediately. It may be disposed before any caller awaits ready();
    // observe that rejection here while preserving it for actual callers.
    void ready.catch(() => undefined);
    return ready;
  }

  onProgress(listener: ProgressListener): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onTrace(listener: TraceListener): () => void {
    this.assertActive();
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }

  ready(): Promise<void> {
    this.assertActive();
    return this.readyPromise;
  }

  async build(project: Project, cacheKey: string): Promise<BuildResult> {
    this.assertActive();
    assertValidProject(project);
    assertCompilerCacheKey(cacheKey);
    toolchainProfileSource(
      this.toolchains,
      project.config.language,
      project.config.target,
      project.config.optimization,
    );
    if (this.activeOperation) throw new Error("BrowserCompiler accepts one active operation at a time.");
    const boundedClang = usesOutputReadyClang(project);
    const maximumClangStages = assertOutputReadyClangStageBudget(project);
    const maximumRustStages = maximumOutputReadyRustStages(project);
    const persistentRust = maximumRustStages > 0;
    const persistentGo = project.config.language === "go";
    const operation: CompilerOperation = { kind: "build" };
    this.activeOperation = operation;
    const crossesClangBoundary = this.outputReadyClangStages > 0
      && (
        !boundedClang
        || this.outputReadyClangStages + maximumClangStages > MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER
      );
    const crossesRustBoundary = this.outputReadyRustStages > 0
      && (
        !persistentRust
        || this.outputReadyRustStages + maximumRustStages > MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER
      );
    const crossesGoBoundary = this.retainedGoStage && !persistentGo;
    let buildWorker: Worker | undefined;
    let retainWorker = false;
    try {
      if (crossesClangBoundary || crossesRustBoundary || crossesGoBoundary) {
        await this.quiesceAndReplaceWorker(
          new Error("Compiler Worker recycled at the output-ready stage boundary."),
        );
        this.activeOperation = operation;
      }
      const generation = this.generation;
      await this.readyPromise;
      this.assertActive();
      if (generation !== this.generation) throw new Error("Browser compilation was superseded by a Worker replacement.");
      await this.acquireToolchain(project);
      this.assertActive();
      if (generation !== this.generation) throw new Error("Browser compilation was superseded by a Worker replacement.");
      buildWorker = this.worker;
      const result = await this.request<BuildResult>(
        { type: "build", project, cacheKey },
        buildControlTimeoutMs(project.config.language),
      );
      if (boundedClang) {
        this.outputReadyClangStages += observedOutputReadyClangStages(result, maximumClangStages);
        retainWorker = true;
      } else if (persistentRust) {
        // rustc owns an immutable package and a serialized Wasmer thread pool
        // inside this Worker. Retaining both makes edit/build cycles warm.
        this.outputReadyRustStages += maximumRustStages;
        retainWorker = true;
      } else if (persistentGo) {
        // Runtime-core drops each compile pipeline; only verified immutable
        // toolchain and standard-library bytes remain warm in the Go stage.
        this.retainedGoStage = true;
        retainWorker = true;
      }
      return result;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
      if (!this.disposed && buildWorker && this.worker === buildWorker && !retainWorker) {
        this.replaceWorker(new Error("Compiler Worker recycled after isolated build."));
      }
    }
  }

  async clearToolchainCache(): Promise<void> {
    this.assertActive();
    if (this.activeOperation) throw new Error("BrowserCompiler accepts one active operation at a time.");
    const operation: CompilerOperation = { kind: "cache-clear" };
    this.activeOperation = operation;
    this.stopWorker(new Error("Compiler Worker recycled before clearing caches."));
    const generation = this.generation;
    this.acquiredToolchains.clear();
    try {
      const names = await caches.keys();
      await Promise.all([
        ...names
          .filter((name) => name === WASM_OJ_STORAGE.toolchainCache)
          .map((name) => caches.delete(name)),
        clearClangBuildGraphCache(),
      ]);
      this.assertActive();
      if (generation !== this.generation) throw new Error("Compiler cache clearing was superseded by a lifecycle change.");
      this.installWorker();
      await this.readyPromise;
      this.assertActive();
      if (generation !== this.generation) throw new Error("Compiler cache clearing was superseded by a lifecycle change.");
    } finally {
      if (!this.disposed && generation === this.generation && this.workerDormant) this.installWorker();
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.activeOperation?.kind === "cache-clear") return;
    this.replaceWorker(new Error("Compilation cancelled."));
  }

  restart(): void {
    this.assertActive();
    if (this.activeOperation?.kind === "cache-clear") {
      throw new Error("Cannot restart BrowserCompiler while clearing its cache.");
    }
    this.replaceWorker(new Error("Compiler worker restarted."));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.workerDormant = true;
    this.activeOperation = undefined;
    this.worker.terminate();
    const error = new Error("Compiler client disposed.");
    this.acquisition?.abort(error);
    this.acquisition = undefined;
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.progressListeners.clear();
    this.traceListeners.clear();
  }

  private createWorker(): Worker {
    const worker = createModuleWorker(CompilerWorkerUrl, { name: "wasm-oj-compiler" });
    worker.addEventListener("message", (event: MessageEvent<CompilerResponse>) => {
      if (!this.disposed && !this.workerDormant && this.worker === worker) this.handleMessage(event.data);
    });
    const crashed = (error: Error) => {
      if (this.disposed || this.workerDormant || this.worker !== worker) return;
      const canRecover = this.workerInitialized;
      this.stopWorker(error);
      if (canRecover) this.installWorker();
    };
    worker.addEventListener("error", (event) => crashed(new Error(event.message || "The compiler worker crashed.")));
    onModuleWorkerLost(worker, crashed);
    return worker;
  }

  private replaceWorker(error: Error): void {
    this.stopWorker(error);
    this.installWorker();
  }

  private async quiesceAndReplaceWorker(reason: Error): Promise<void> {
    const generation = this.generation;
    try {
      await this.request<void>({ type: "quiesce" }, QUIESCE_TIMEOUT_MS);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (!this.disposed && generation === this.generation) this.replaceWorker(cause);
      throw new Error("Compiler could not establish a quiescent Worker boundary.", { cause });
    }
    this.assertActive();
    if (generation !== this.generation) {
      throw new Error("Compiler quiescence was superseded by a lifecycle change.");
    }
    this.stopWorker(reason);
    this.installWorker();
  }

  /**
   * Downloads the build's pinned toolchain assets into the HTTP or toolchain
   * cache before the build boundary starts, so a slow network cannot spend the
   * compiler request timeout, and a recycled Worker reuses completed downloads.
   */
  private async acquireToolchain(project: Project): Promise<void> {
    const { language, target, optimization } = project.config;
    const libcxxPrecompiledHeader = language === "cpp" && project.files.some((file) =>
      file.path.slice(file.path.lastIndexOf("/") + 1) === "wasm-oj.pch.hpp"
      && isToolchainLibcxxPchHeader(file.content));
    const key = JSON.stringify([language, target, optimization, libcxxPrecompiledHeader]);
    if (this.acquiredToolchains.has(key)) return;
    const acquisition = new AbortController();
    this.acquisition = acquisition;
    try {
      await prefetchBrowserToolchain(this.toolchains, {
        language,
        target,
        optimization,
        libcxxPrecompiledHeader,
        signal: acquisition.signal,
        onProgress: ({ loadedBytes, totalBytes }) => {
          const progress = {
            phase: "loading-toolchain" as const,
            label: "Downloading pinned toolchain",
            progress: totalBytes > 0 ? loadedBytes / totalBytes : 1,
          };
          for (const listener of this.progressListeners) listener(progress);
        },
      });
    } finally {
      if (this.acquisition === acquisition) this.acquisition = undefined;
    }
    this.acquiredToolchains.add(key);
  }

  private stopWorker(error: Error): void {
    this.acquisition?.abort(error);
    this.acquisition = undefined;
    this.generation += 1;
    this.workerDormant = true;
    if (this.activeOperation?.kind === "build") this.activeOperation = undefined;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.outputReadyClangStages = 0;
    this.outputReadyRustStages = 0;
    this.retainedGoStage = false;
    this.workerInitialized = false;
  }

  private installWorker(): void {
    this.worker = this.createWorker();
    this.workerDormant = false;
    this.readyPromise = this.initializeWorker();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("BrowserCompiler is disposed.");
  }

  private request<T>(request: CompilerRequestWithoutId, timeoutMs: number): Promise<T> {
    this.assertActive();
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<unknown> = {
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      pending.timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        const error = new Error(`Compiler request exceeded the ${timeoutMs} ms browser boundary.`);
        reject(error);
        if (!this.disposed) this.replaceWorker(error);
      }, timeoutMs);
      this.pending.set(requestId, pending);
      try {
        this.worker.postMessage({ ...request, requestId } as CompilerRequest);
      } catch (error) {
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(response: CompilerResponse): void {
    if (response.type === "progress") {
      for (const listener of this.progressListeners) listener(response.progress);
      return;
    }
    if (response.type === "compile-trace") {
      for (const listener of this.traceListeners) listener(response.requestId, response.event);
      return;
    }
    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);
    if (request.timer) clearTimeout(request.timer);

    switch (response.type) {
      case "ready":
        this.workerInitialized = true;
        request.resolve(undefined);
        break;
      case "quiesced":
        request.resolve(undefined);
        break;
      case "build-result":
        request.resolve(response.result);
        break;
      case "error":
        request.reject(Object.assign(new Error(response.message), { code: response.code, stack: response.stack }));
        break;
    }
  }
}
