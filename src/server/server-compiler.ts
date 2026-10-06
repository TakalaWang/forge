import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { Wasmer } from "@wasmer/sdk/node";
import type { Compiler } from "@wasm-oj/core";
import {
  assertCompilerCacheKey,
  assertValidProject,
  toolchainAssetSource,
  toolchainCacheIdentity,
} from "@wasm-oj/core";
import { WASM_OJ_SCHEMAS } from "@wasm-oj/contracts";
import type {
  BuildResult,
  Project,
  ServerToolchainSource,
  WorkerProgress,
} from "@wasm-oj/contracts";
import { clearSdkDirectClangBuildGraph, clearSdkDirectClangCaches } from "../compiler/sdk-direct-clang.ts";
import {
  buildProject,
  clearCompilerHostCaches,
  configureWasmerCompilerHost,
} from "../compiler/wasmer-engine.ts";
import { parseGoDiagnostics, parseRustDiagnostics } from "../core/diagnostics.ts";
import type {
  RustCompileRequest,
  RustCompileResult,
} from "../compiler/rust-toolchain.ts";
import { RUST_COMPILE_TIMEOUT_MS, RUST_TOOLCHAIN } from "../compiler/rust-toolchain.ts";
import {
  MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER,
  OUTPUT_READY_RUST_STAGES_PER_BUILD,
} from "../compiler/browser-rust-policy.ts";
import type { GoCompileRequest, GoCompileResult } from "../compiler/go-toolchain.ts";
import { GO_COMPILE_TIMEOUT_MS, GO_TOOLCHAIN } from "../compiler/go-toolchain.ts";
import type { JavaCompileRequest, JavaCompileResult } from "../compiler/java-toolchain.ts";
import { JAVA_COMPILE_TIMEOUT_MS } from "../compiler/java-toolchain.ts";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
} from "../core/toolchains.ts";
import { BoundedByteCollector, readBoundedRegularFile } from "./bounded-transport.ts";
import { ReusableStage } from "./reusable-stage.ts";
import { buildControlTimeoutMs } from "../compiler/build-timeout-policy.ts";
import {
  assertVerifiedToolchainDistribution,
  type VerifiedServerDistribution,
} from "./verified-distribution.ts";
import {
  assertServerToolchainProfile,
  serializeServerToolchainSources,
  serverToolchainAssetFile,
  serverToolchainAssetFiles,
  serverToolchainDirectories,
  snapshotServerToolchainSources,
} from "./toolchain-sources.ts";
import {
  resolveServerStageDirectory,
  serverStageScript,
  type ServerStageScript,
} from "./stage-scripts.ts";

export interface ServerCompilerOptions {
  /** Native `wasm-oj-compiler` executable built from `crates/runtime-core`. */
  compilerExecutable: string;
  /** Explicit package-owned toolchain sources. */
  toolchains: readonly ServerToolchainSource[];
  /** @internal Verified immutable-container capability. */
  verifiedDistribution?: VerifiedServerDistribution;
  /** @internal Inherited only by the private isolated build stage. */
  verifiedToolchain?: boolean;
}

const IN_PROCESS_STAGE = Symbol("wasm-oj-in-process-server-compiler");
const SERVER_STAGE_LOG_LIMIT_BYTES = 1024 * 1024;
const SERVER_STAGE_PROGRESS_LINE_LIMIT_BYTES = 1024 * 1024;
const SERVER_BUILD_RESPONSE_LIMIT_BYTES = 256 * 1024 * 1024;
const SERVER_BUILD_REQUEST_LIMIT_BYTES = 768 * 1024 * 1024;
const SERVER_COMPILER_STAGE_RESPONSE_LIMIT_BYTES = 256 * 1024 * 1024;
const SERVER_STAGE_IDLE_TIMEOUT_MS = 30_000;
const SERVER_RUST_BUILDS_PER_STAGE = MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER / OUTPUT_READY_RUST_STAGES_PER_BUILD;
interface ServerCompilerStageOptions extends ServerCompilerOptions {
  /** @internal Canonical stage root inherited from the package entry process. */
  stageDirectory: string;
}

interface ServerCompilerOperation {
  kind: "build" | "cache-clear";
  generation: number;
  superseded: boolean;
}

/**
 * Node/server compiler host using the exact language drivers and Wasmer
 * packages used by the browser Worker.
 */
export class ServerCompiler implements Compiler {
  private readonly progressListeners = new Set<(progress: WorkerProgress) => void>();
  private readonly compilerExecutable: string;
  private readonly toolchains: readonly ServerToolchainSource[];
  private initialization: Promise<void> | undefined;
  private generation = 0;
  private disposed = false;
  private readonly inProcess: boolean;
  private readonly verifiedToolchain: boolean;
  private readonly stageDirectory: string;
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();
  private activeOperation: ServerCompilerOperation | undefined;
  private buildStage: ReusableStage | undefined;
  private rustStage: ReusableStage | undefined;
  private wasmer: Wasmer | undefined;

  constructor(options: ServerCompilerOptions);
  /** @internal */
  constructor(options: ServerCompilerStageOptions, stage: typeof IN_PROCESS_STAGE);
  constructor(options: ServerCompilerOptions | ServerCompilerStageOptions, stage?: typeof IN_PROCESS_STAGE) {
    this.compilerExecutable = path.resolve(options.compilerExecutable);
    this.toolchains = snapshotServerToolchainSources(options.toolchains);
    if (options.verifiedDistribution) {
      assertVerifiedToolchainDistribution(options.verifiedDistribution, this.toolchains);
    }
    if (options.verifiedToolchain === true && stage !== IN_PROCESS_STAGE) {
      throw new Error("Verified toolchain inheritance is reserved for the isolated compiler stage.");
    }
    this.verifiedToolchain = options.verifiedDistribution !== undefined || options.verifiedToolchain === true;
    this.inProcess = stage === IN_PROCESS_STAGE;
    if (stage === IN_PROCESS_STAGE) {
      const inheritedStageDirectory = (options as ServerCompilerStageOptions).stageDirectory;
      if (typeof inheritedStageDirectory !== "string" || !path.isAbsolute(inheritedStageDirectory)) {
        throw new Error("The inherited @wasm-oj/server stage directory must be absolute.");
      }
      this.stageDirectory = inheritedStageDirectory;
    } else {
      this.stageDirectory = resolveServerStageDirectory();
    }
  }

  cacheIdentity(project: Project): string {
    this.assertActive();
    assertServerToolchainProfile(
      this.toolchains,
      project.config.language,
      project.config.target,
      project.config.optimization,
    );
    return JSON.stringify(toolchainCacheIdentity(project.config.language));
  }

  async ready(): Promise<void> {
    this.assertActive();
    const generation = this.generation;
    let initialization = this.initialization;
    if (!initialization) {
      initialization = this.initialize();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    await initialization;
    this.assertActive();
    if (generation !== this.generation) throw new Error("Server compiler initialization was superseded.");
  }

  async build(project: Project, cacheKey: string): Promise<BuildResult> {
    assertValidProject(project);
    assertCompilerCacheKey(cacheKey);
    const operation = this.beginOperation("build");
    try {
      await this.ready();
      this.assertCurrent(operation, "Server compilation was cancelled before initialization completed.");
      if (!this.inProcess) return await this.buildIsolated(project, cacheKey, operation);
      // The in-process compiler runs only inside a stage child that serves sequential builds,
      // so the client is never closed: SDK shutdown terminates workers mid-task.
      const wasmer = this.wasmer ??= new Wasmer({ cache: false });
      configureWasmerCompilerHost({
        getWasmer: () => wasmer,
        loadToolchainAsset: (assetPath) => this.loadToolchainAsset(assetPath),
        loadToolchainFile: (assetPath) => this.loadToolchainFile(assetPath),
        compileRust: (request) => this.compileRust(request),
        compileGo: (request) => this.compileGo(request),
        compileJava: (request) => this.compileJava(request),
        progress: (_requestId, phase, label, value) => {
          if (!this.isCurrent(operation)) return;
          const progress = { phase, label, progress: value };
          for (const listener of this.progressListeners) listener(progress);
        },
        trace: () => undefined,
      });
      try {
        const result = await buildProject(project, cacheKey, crypto.randomUUID());
        this.assertCurrent(operation, "Server compilation was cancelled.");
        return result;
      } finally {
        clearSdkDirectClangBuildGraph();
      }
    } finally {
      this.endOperation(operation);
    }
  }

  onProgress(listener: (progress: WorkerProgress) => void): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async clearToolchainCache(): Promise<void> {
    const operation = this.beginOperation("cache-clear");
    try {
      await this.ready();
      this.assertCurrent(operation, "Server compiler cache clearing was superseded.");
      if (this.inProcess) {
        clearCompilerHostCaches();
        await clearSdkDirectClangCaches();
        this.assertCurrent(operation, "Server compiler cache clearing was superseded.");
      }
    } finally {
      this.endOperation(operation);
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.activeOperation?.kind === "cache-clear") return;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation = undefined;
    }
    this.terminateChildren();
  }

  restart(): void {
    this.assertActive();
    if (this.activeOperation?.kind === "cache-clear") {
      throw new Error("Cannot restart ServerCompiler while clearing its cache.");
    }
    this.cancel();
    if (this.inProcess) clearCompilerHostCaches();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation = undefined;
    }
    this.terminateChildren();
    this.progressListeners.clear();
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      access(this.compilerExecutable, fsConstants.X_OK),
      ...serverToolchainDirectories(this.toolchains).map((directory) => access(directory, fsConstants.R_OK)),
    ]);
  }

  private async buildIsolated(
    project: Project,
    cacheKey: string,
    operation: ServerCompilerOperation,
  ): Promise<BuildResult> {
    const transportDirectory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-build-response-"));
    const responsePath = path.join(transportDirectory, "response.v8");
    const requestPath = path.join(transportDirectory, "request.v8");
    const timeoutMs = buildControlTimeoutMs(project.config.language);
    try {
      this.assertCurrent(operation, "Server compilation was cancelled before its isolated stage started.");
      const encodedRequest = serialize({
        compilerExecutable: this.compilerExecutable,
        stageDirectory: this.stageDirectory,
        toolchains: serializeServerToolchainSources(this.toolchains),
        verifiedToolchain: this.verifiedToolchain,
        project,
        cacheKey,
      });
      if (encodedRequest.byteLength > SERVER_BUILD_REQUEST_LIMIT_BYTES) {
        throw new Error(`Server compiler request exceeds ${SERVER_BUILD_REQUEST_LIMIT_BYTES} bytes.`);
      }
      await writeFile(requestPath, encodedRequest, { flag: "wx", mode: 0o600 });
      this.buildStage ??= new ReusableStage({
        script: serverStageScript(this.stageDirectory, "server-build-stage.mjs"),
        label: "isolated server compiler",
        lineLimitBytes: SERVER_STAGE_PROGRESS_LINE_LIMIT_BYTES,
        idleTimeoutMs: SERVER_STAGE_IDLE_TIMEOUT_MS,
        terminationGraceMs: 1_000,
      });
      return await this.buildStage.run({
        request: JSON.stringify({ requestPath, responsePath }),
        timeoutMs,
        timeoutMessage: `Server compilation exceeded ${timeoutMs} ms.`,
        line: (line) => {
          let message: { complete?: unknown };
          try {
            message = JSON.parse(line) as { complete?: unknown };
          } catch {
            // Compiler internals may write non-protocol data to fd 3.
            return false;
          }
          if (message.complete === true) return true;
          if (this.isCurrent(operation)) {
            for (const listener of this.progressListeners) listener(message as WorkerProgress);
          }
          return false;
        },
        complete: async ({ stdout, stderr }) => {
          this.assertCurrent(operation, "Server compilation was cancelled.");
          let encodedResponse: Buffer;
          try {
            encodedResponse = await readBoundedRegularFile(responsePath, SERVER_BUILD_RESPONSE_LIMIT_BYTES);
          } catch (error) {
            const stageError = stderr.trim() || stdout.trim();
            if (stageError) throw new Error(stageError, { cause: error });
            throw error;
          }
          const response = deserialize(encodedResponse) as {
            ok: boolean;
            result?: BuildResult;
            error?: string;
          };
          if (!response.ok || !response.result) {
            throw new Error(response.error || stderr || stdout || "The isolated server compiler failed.");
          }
          return response.result;
        },
      });
    } catch (error) {
      this.assertCurrent(operation, "Server compilation was cancelled.");
      throw error;
    } finally {
      await rm(transportDirectory, { recursive: true, force: true });
    }
  }

  private async compileRust(request: RustCompileRequest): Promise<RustCompileResult> {
    const result = await this.runRustStage<Omit<RustCompileResult, "wasm"> & { wasmBase64?: string }>({ request });
    return {
      ...result,
      diagnostics: parseRustDiagnostics(result.stderr),
      wasm: result.wasmBase64
        ? new Uint8Array(Buffer.from(result.wasmBase64, "base64"))
        : undefined,
    };
  }

  private async compileGo(request: GoCompileRequest): Promise<GoCompileResult> {
    const result = await this.runCompilerStage<Omit<GoCompileResult, "wasm" | "diagnostics"> & { wasmBase64?: string }>(
      "go-stage.mjs",
      { compilerExecutable: this.compilerExecutable, compileBatchSchema: WASM_OJ_SCHEMAS.compileBatch, request },
      GO_COMPILE_TIMEOUT_MS,
      [GO_TOOLCHAIN.packageAsset, GO_TOOLCHAIN.manifestAsset, GO_TOOLCHAIN.standardLibraryAsset],
    );
    return {
      ...result,
      diagnostics: parseGoDiagnostics(result.stderr),
      wasm: result.wasmBase64
        ? new Uint8Array(Buffer.from(result.wasmBase64, "base64"))
        : undefined,
    };
  }

  private async compileJava(request: JavaCompileRequest): Promise<JavaCompileResult> {
    const result = await this.runCompilerStage<Omit<JavaCompileResult, "wasm"> & { wasmBase64?: string }>(
      "java-stage.mjs",
      { request },
      JAVA_COMPILE_TIMEOUT_MS,
      [
        JAVA_COMPILER_ASSET_PATH,
        JAVA_COMPILE_CLASSLIB_ASSET_PATH,
        JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
      ],
    );
    return {
      ...result,
      wasm: result.wasmBase64
        ? new Uint8Array(Buffer.from(result.wasmBase64, "base64"))
        : undefined,
    };
  }

  private runRustStage<T>(input: object): Promise<T> {
    const operation = this.activeOperation;
    if (!operation || operation.kind !== "build") {
      return Promise.reject(new Error("Server compilation was cancelled before its compiler stage started."));
    }
    this.assertCurrent(operation, "Server compilation was cancelled before its compiler stage started.");
    const timeoutMs = RUST_COMPILE_TIMEOUT_MS + 5_000;
    this.rustStage ??= new ReusableStage({
      script: serverStageScript(this.stageDirectory, "rustc-stage.mjs"),
      label: "isolated compiler stage 'rustc-stage.mjs'",
      lineLimitBytes: SERVER_COMPILER_STAGE_RESPONSE_LIMIT_BYTES,
      idleTimeoutMs: SERVER_STAGE_IDLE_TIMEOUT_MS,
      maxExchanges: SERVER_RUST_BUILDS_PER_STAGE,
    });
    let responseLine = "";
    return this.rustStage.run({
      request: JSON.stringify({
        toolchainAssets: serverToolchainAssetFiles(this.toolchains, [RUST_TOOLCHAIN.packageAsset, RUST_TOOLCHAIN.manifestAsset]),
        verifiedToolchain: this.verifiedToolchain,
        ...input,
      }),
      timeoutMs,
      timeoutMessage: `The isolated compiler stage 'rustc-stage.mjs' exceeded ${timeoutMs} ms.`,
      line: (line) => {
        responseLine = line;
        return true;
      },
      complete: ({ stdout, stderr }) => {
        const response = JSON.parse(responseLine) as { ok: boolean; result?: T; error?: string };
        if (!response.ok || !response.result) {
          throw new Error(response.error || stderr || stdout || "The isolated compiler stage 'rustc-stage.mjs' failed.");
        }
        return response.result;
      },
    });
  }

  private runCompilerStage<T>(
    scriptName: Exclude<ServerStageScript, "server-build-stage.mjs" | "server-runner-stage.mjs" | "rustc-stage.mjs">,
    input: object,
    timeoutMs: number,
    assetPaths: readonly string[],
  ): Promise<T> {
    const operation = this.activeOperation;
    if (!operation || operation.kind !== "build") {
      return Promise.reject(new Error("Server compilation was cancelled before its compiler stage started."));
    }
    this.assertCurrent(operation, "Server compilation was cancelled before its compiler stage started.");
    return new Promise((resolve, reject) => {
      const script = serverStageScript(this.stageDirectory, scriptName);
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
        { stdio: ["pipe", "pipe", "pipe", "pipe"] },
      );
      this.activeChildren.add(child);
      let transportError: Error | undefined;
      let timedOut = false;
      const failTransport = (error: Error) => {
        transportError ??= error;
        child.kill("SIGKILL");
      };
      const stdout = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' stdout`,
        SERVER_STAGE_LOG_LIMIT_BYTES,
        failTransport,
      );
      const stderr = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' stderr`,
        SERVER_STAGE_LOG_LIMIT_BYTES,
        failTransport,
      );
      const responseBytes = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' response`,
        SERVER_COMPILER_STAGE_RESPONSE_LIMIT_BYTES,
        failTransport,
      );
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.on("error", (error) => { transportError = error; });
      child.stdin.on("error", (error) => { transportError ??= error; });
      const responseStream = child.stdio[3];
      if (!responseStream || typeof responseStream === "number") {
        child.kill("SIGKILL");
        this.activeChildren.delete(child);
        reject(new Error(`The isolated compiler stage '${scriptName}' did not expose its response channel.`));
        return;
      }
      responseStream.on("data", (chunk: Buffer) => responseBytes.append(chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs + 5_000);
      child.on("close", () => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        try {
          if (transportError) throw transportError;
          if (timedOut) throw new Error(`The isolated compiler stage '${scriptName}' exceeded ${timeoutMs + 5_000} ms.`);
          const response = JSON.parse(responseBytes.text()) as {
            ok: boolean;
            result?: T;
            error?: string;
          };
          if (!response.ok || !response.result) {
            throw new Error(
              response.error
              || stderr.text()
              || stdout.text()
              || `The isolated compiler stage '${scriptName}' failed.`,
            );
          }
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({
        toolchainAssets: serverToolchainAssetFiles(this.toolchains, assetPaths),
        verifiedToolchain: this.verifiedToolchain,
        ...input,
      }));
    });
  }

  private async loadToolchainAsset(assetPath: string): Promise<Uint8Array> {
    const resolved = serverToolchainAssetFile(this.toolchains, assetPath);
    const compressed = await readFile(resolved);
    if (!this.verifiedToolchain) this.verifyToolchainAsset(assetPath, compressed);
    return uint8View(gunzipSync(compressed));
  }

  private async loadToolchainFile(assetPath: string): Promise<Uint8Array> {
    const resolved = serverToolchainAssetFile(this.toolchains, assetPath);
    const bytes = await readFile(resolved);
    if (!this.verifiedToolchain) this.verifyToolchainAsset(assetPath, bytes);
    return new Uint8Array(bytes);
  }

  private verifyToolchainAsset(assetPath: string, bytes: Uint8Array): void {
    const expected = toolchainAssetSource(this.toolchains, assetPath).asset.sha256;
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(`Pinned toolchain asset '${assetPath}' has digest ${actual}; expected ${expected}.`);
    }
  }

  private beginOperation(kind: ServerCompilerOperation["kind"]): ServerCompilerOperation {
    this.assertActive();
    if (this.activeOperation) throw new Error("ServerCompiler accepts one active operation at a time.");
    const operation = { kind, generation: this.generation, superseded: false };
    this.activeOperation = operation;
    return operation;
  }

  private endOperation(operation: ServerCompilerOperation): void {
    if (this.activeOperation === operation) this.activeOperation = undefined;
  }

  private assertCurrent(operation: ServerCompilerOperation, message: string): void {
    this.assertActive();
    if (!this.isCurrent(operation)) throw new Error(message);
  }

  private isCurrent(operation: ServerCompilerOperation): boolean {
    return !this.disposed && !operation.superseded && operation.generation === this.generation;
  }

  private terminateChildren(): void {
    this.buildStage?.terminate();
    this.rustStage?.terminate();
    for (const child of this.activeChildren) {
      if (this.inProcess) {
        child.kill("SIGKILL");
        continue;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.activeChildren.has(child)) child.kill("SIGKILL");
      }, 1_000).unref();
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ServerCompiler is disposed.");
  }
}

function uint8View(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

let stageCompiler: { identity: string; compiler: ServerCompiler } | undefined;

/** @internal Entry point used only by the isolated Node compiler process. */
export async function buildServerProjectInProcess(
  options: ServerCompilerStageOptions,
  project: Project,
  cacheKey: string,
  onProgress: (progress: WorkerProgress) => void,
): Promise<BuildResult> {
  const identity = JSON.stringify(options);
  if (stageCompiler?.identity !== identity) {
    disposeServerBuildStage();
    stageCompiler = { identity, compiler: new ServerCompiler(options, IN_PROCESS_STAGE) };
  }
  const { compiler } = stageCompiler;
  const removeProgress = compiler.onProgress(onProgress);
  try {
    return await compiler.build(project, cacheKey);
  } finally {
    removeProgress();
  }
}

/** @internal Releases the isolated compiler process's reusable compiler state. */
export function disposeServerBuildStage(): void {
  stageCompiler?.compiler.dispose();
  stageCompiler = undefined;
}
