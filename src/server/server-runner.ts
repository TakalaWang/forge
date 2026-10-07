import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { WASM_OJ_SCHEMAS } from "@wasm-oj/contracts";
import {
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
} from "../core/toolchains";
import {
  createExtendedCostBaselineRegistry,
  createDefaultRuntimeDrivers,
  normalizeExecutionMetrics,
  prepareArtifactInteraction,
  prepareArtifactRun,
  prepareTrustedJudgeRun,
  RuntimeDriverRegistry,
  unavailableExecutionMetrics,
  WEIGHTED_METER_MODEL,
  type PackageFileSystemRequest,
  type PreparedRunRequest,
  type RawExecutionMetrics,
  type Runner,
  type RuntimeResolver,
  type TrustedJudgeProgram,
} from "@wasm-oj/core";
import type {
  BuildArtifact,
  ExecutionTermination,
  InteractiveProcessResult,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunConfig,
  RunResult,
  ServerToolchainSource,
  WorkerProgress,
} from "@wasm-oj/contracts";
import { verifyAndDecodeRuntimeFiles } from "../runner/runtime-files";
import { BoundedByteCollector, readBoundedRegularFile } from "./bounded-transport.ts";
import { DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS, runtimePreparationTimeoutMs } from "../runner/preparation-timeout-policy.ts";
import {
  assertVerifiedToolchainDistribution,
  type VerifiedServerDistribution,
} from "./verified-distribution.ts";
import {
  assertServerToolchainProfile,
  serverToolchainAssetFile,
  serverToolchainDirectories,
  snapshotServerToolchainSources,
} from "./toolchain-sources.ts";
import { resolveServerStageDirectory, serverStageScript } from "./stage-scripts.ts";

export interface ServerRunnerOptions {
  /** Native `wasm-oj-runner` executable built from `crates/runtime-core`. */
  runtimeExecutable: string;
  /** Explicit package-owned toolchain sources. */
  toolchains: readonly ServerToolchainSource[];
  /** Writable directory for deterministic runtime filesystem archives. */
  cacheDirectory: string;
  /** Optional runtime-driver registry, used by calibration and embedders. */
  runtimeDrivers?: RuntimeDriverRegistry;
  /** Calibrated profiles for downstream languages using the built-in runtime drivers. */
  additionalCostBaselines?: Readonly<Record<string, number>>;
  /** @internal Verified immutable-container capability. */
  verifiedDistribution?: VerifiedServerDistribution;
}

interface NativeCoreResult {
  code: number;
  stdoutBase64: string;
  stderrBase64: string;
  filesBase64: Record<string, string>;
  termination: ExecutionTermination;
  trapMessage?: string | null;
  metrics: RawExecutionMetrics;
}

interface NativeCoreResponse {
  ok: boolean;
  result?: NativeCoreResult;
  error?: { code: string; message: string };
}

interface NativeInteractiveProcessResult {
  code: number;
  stderrBase64: string;
  termination: ExecutionTermination;
  metrics: {
    cost: number;
    operations: Record<string, number>;
    logicalTimeNs: number;
    filesystemBytes: number;
    filesystemEntries: number;
    protocolBytes: number;
    stderrBytes: number;
  };
}

interface NativeInteractiveResponse {
  ok: boolean;
  result?: {
    contestant: NativeInteractiveProcessResult;
    interactor: NativeInteractiveProcessResult;
    contestantToInteractorBase64: string;
    interactorToContestantBase64: string;
  };
  error?: { code: string; message: string };
}

interface ActiveNativeRun {
  child: ChildProcessWithoutNullStreams;
  abort(error: Error): void;
}

interface ServerRunOperation {
  generation: number;
  superseded: boolean;
  cancellation: Promise<never>;
  cancel(error: Error): void;
  track<T>(task: Promise<T>): Promise<T>;
  quiesce(): Promise<void>;
  completion: Promise<void>;
  complete(): void;
}

interface ActivePreparationStage {
  operation: ServerRunOperation;
  abort(error: Error): void;
}

type RunnerStageRequest =
  | {
      operation: "command-binary";
      packageSpecifier: string;
      command: string;
    }
  | {
      operation: "runtime-files";
      packageSpecifier: string;
      command: string;
      args: string[];
    };

interface RunnerStageResult {
  operation: RunnerStageRequest["operation"];
  bytes: Uint8Array;
}

const WASM_OJ_RUNTIME_CACHE_FILE = /^[0-9a-f]{64}\.wasmojfs$/;
const WASM_OJ_RUNTIME_CACHE_TEMPORARY_FILE =
  /^[0-9a-f]{64}\.wasmojfs\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const SERVER_RUNNER_STAGE_SCRIPT = "server-runner-stage.mjs";
const MAX_RUNNER_STAGE_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_RUNNER_STAGE_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_RUNTIME_CACHE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_CORE_DIAGNOSTIC_BYTES = 1024 * 1024;
const NATIVE_CORE_RESPONSE_OVERHEAD_BYTES = 2 * 1024 * 1024;

export class ServerRunner implements Runner {
  private readonly runtimeExecutable: string;
  private readonly toolchains: readonly ServerToolchainSource[];
  private readonly cacheDirectory: string;
  private readonly verifiedToolchain: boolean;
  private readonly stageDirectory: string;
  private resolvedCacheDirectory: string | undefined;
  private readonly runtimeDrivers: RuntimeDriverRegistry;
  private readonly packageCommands = new Map<string, Promise<Uint8Array>>();
  private readonly packageFileSystems = new Map<string, Promise<Record<string, Uint8Array>>>();
  private readonly progressListeners = new Set<(progress: WorkerProgress) => void>();
  private readonly streamListeners = new Set<(stream: "stdout" | "stderr", chunk: string) => void>();
  private initialization: Promise<void> | undefined;
  private readonly activeNativeRuns = new Set<ActiveNativeRun>();
  private readonly activePreparationStages = new Set<ActivePreparationStage>();
  private readonly inFlightRuns = new Set<ServerRunOperation>();
  private activeOperation: ServerRunOperation | undefined;
  private cacheClearActive = false;
  private generation = 0;
  private disposed = false;

  constructor(options: ServerRunnerOptions) {
    this.runtimeExecutable = path.resolve(options.runtimeExecutable);
    this.toolchains = snapshotServerToolchainSources(options.toolchains);
    if (options.verifiedDistribution) {
      assertVerifiedToolchainDistribution(options.verifiedDistribution, this.toolchains);
    }
    this.verifiedToolchain = options.verifiedDistribution !== undefined;
    this.stageDirectory = resolveServerStageDirectory();
    this.cacheDirectory = path.resolve(options.cacheDirectory);
    assertCacheDirectoryIsNotFilesystemRoot(this.cacheDirectory);
    if (options.runtimeDrivers && options.additionalCostBaselines) {
      throw new Error("Provide either runtimeDrivers or additionalCostBaselines, not both.");
    }
    this.runtimeDrivers = options.runtimeDrivers ?? createDefaultRuntimeDrivers(
      createExtendedCostBaselineRegistry(options.additionalCostBaselines),
    );
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
    if (generation !== this.generation) throw new Error("Server runner initialization was superseded.");
  }

  async run(artifact: BuildArtifact, config: RunConfig): Promise<RunResult> {
    this.assertActive();
    this.assertArtifactToolchain(artifact);
    if (this.activeOperation || this.cacheClearActive) {
      throw new Error("ServerRunner accepts one active operation at a time.");
    }
    const operation = createServerRunOperation(this.generation);
    this.activeOperation = operation;
    this.inFlightRuns.add(operation);
    try {
      await this.ready();
      this.assertCurrent(operation, "Server execution was cancelled before runtime preparation completed.");
      const started = performance.now();
      this.progress({ phase: "loading-toolchain", label: `Resolving runtime for ${artifact.name}`, progress: 0.1 });
      this.assertCurrent(operation, "Server execution was cancelled before runtime preparation started.");
      const prepared = await this.prepareWithDeadline(operation, artifact, config);
      this.assertCurrent(operation, "Server execution was cancelled during runtime preparation.");
      this.progress({ phase: "running", label: `Running ${artifact.name} with native deterministic Wasmer`, progress: 0.25 });
      this.assertCurrent(operation, "Server execution was cancelled before the native runtime started.");
      const result = await this.runNativeCore(prepared, config, started);
      this.assertCurrent(operation, "Server execution was cancelled before its result was delivered.");
      if (result.stdout) {
        this.stream("stdout", result.stdout);
        this.assertCurrent(operation, "Server execution was cancelled while its output was delivered.");
      }
      if (result.stderr) {
        this.stream("stderr", result.stderr);
        this.assertCurrent(operation, "Server execution was cancelled while its output was delivered.");
      }
      return result;
    } finally {
      await operation.quiesce();
      if (this.activeOperation === operation) this.activeOperation = undefined;
      this.inFlightRuns.delete(operation);
      operation.complete();
    }
  }

  async runTrusted(program: TrustedJudgeProgram, config: RunConfig): Promise<RunResult> {
    this.assertActive();
    if (this.activeOperation || this.cacheClearActive) {
      throw new Error("ServerRunner accepts one active operation at a time.");
    }
    const operation = createServerRunOperation(this.generation);
    this.activeOperation = operation;
    this.inFlightRuns.add(operation);
    try {
      await this.ready();
      this.assertCurrent(operation, "Trusted judge execution was cancelled before preparation completed.");
      const started = performance.now();
      const prepared = await this.prepareTrustedWithDeadline(operation, program, config);
      this.assertCurrent(operation, "Trusted judge execution was cancelled during preparation.");
      const result = await this.runNativeCore(prepared, config, started);
      this.assertCurrent(operation, "Trusted judge execution was cancelled before its result was delivered.");
      return result;
    } finally {
      await operation.quiesce();
      if (this.activeOperation === operation) this.activeOperation = undefined;
      this.inFlightRuns.delete(operation);
      operation.complete();
    }
  }

  async interact(
    contestantArtifact: BuildArtifact,
    interactorArtifact: BuildArtifact,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult> {
    this.assertActive();
    this.assertArtifactToolchain(contestantArtifact);
    this.assertArtifactToolchain(interactorArtifact);
    if (this.activeOperation || this.cacheClearActive) {
      throw new Error("ServerRunner accepts one active operation at a time.");
    }
    const operation = createServerRunOperation(this.generation);
    this.activeOperation = operation;
    this.inFlightRuns.add(operation);
    try {
      await this.ready();
      this.assertCurrent(operation, "Server interaction was cancelled before runtime preparation completed.");
      const started = performance.now();
      this.progress({ phase: "loading-toolchain", label: "Resolving contestant and interactor runtimes", progress: 0.1 });
      const [contestant, interactor] = await Promise.all([
        this.prepareInteractiveWithDeadline(
          operation,
          contestantArtifact,
          interactiveRunConfig(config.contestant, config.determinism),
        ),
        this.prepareInteractiveWithDeadline(
          operation,
          interactorArtifact,
          interactiveRunConfig(config.interactor, config.determinism),
        ),
      ]);
      this.assertCurrent(operation, "Server interaction was cancelled during runtime preparation.");
      this.progress({ phase: "running", label: "Running interactive session with native deterministic Wasmer", progress: 0.25 });
      const result = await this.runNativeInteractive(contestant, interactor, config, started);
      this.assertCurrent(operation, "Server interaction was cancelled before its result was delivered.");
      return result;
    } finally {
      await operation.quiesce();
      if (this.activeOperation === operation) this.activeOperation = undefined;
      this.inFlightRuns.delete(operation);
      operation.complete();
    }
  }

  async interactTrusted(
    contestantArtifact: BuildArtifact,
    interactorProgram: TrustedJudgeProgram,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult> {
    this.assertActive();
    this.assertArtifactToolchain(contestantArtifact);
    if (this.activeOperation || this.cacheClearActive) {
      throw new Error("ServerRunner accepts one active operation at a time.");
    }
    const operation = createServerRunOperation(this.generation);
    this.activeOperation = operation;
    this.inFlightRuns.add(operation);
    try {
      await this.ready();
      this.assertCurrent(operation, "Trusted interaction was cancelled before preparation completed.");
      const started = performance.now();
      const [contestant, interactor] = await Promise.all([
        this.prepareInteractiveWithDeadline(
          operation,
          contestantArtifact,
          interactiveRunConfig(config.contestant, config.determinism),
        ),
        this.prepareTrustedWithDeadline(
          operation,
          interactorProgram,
          interactiveRunConfig(config.interactor, config.determinism),
        ),
      ]);
      this.assertCurrent(operation, "Trusted interaction was cancelled during preparation.");
      return await this.runNativeInteractive(contestant, interactor, config, started);
    } finally {
      await operation.quiesce();
      if (this.activeOperation === operation) this.activeOperation = undefined;
      this.inFlightRuns.delete(operation);
      operation.complete();
    }
  }

  onProgress(listener: (progress: WorkerProgress) => void): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onStream(listener: (stream: "stdout" | "stderr", chunk: string) => void): () => void {
    this.assertActive();
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  async clearRuntimeCache(): Promise<void> {
    this.assertActive();
    if (this.cacheClearActive || this.activeOperation || this.inFlightRuns.size > 0) {
      throw new Error("Cannot clear the runtime cache while execution is still in flight.");
    }
    this.cacheClearActive = true;
    const generation = this.generation;
    try {
      await this.ready();
      this.assertActive();
      if (generation !== this.generation) throw new Error("Server runtime cache clearing was superseded.");
      this.packageCommands.clear();
      this.packageFileSystems.clear();
      await removeWasmOjRuntimeCacheFiles(this.runtimeCacheDirectory());
      this.assertActive();
      if (generation !== this.generation) throw new Error("Server runtime cache clearing was superseded.");
    } finally {
      this.cacheClearActive = false;
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.cacheClearActive) return;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation.cancel(new Error("Server execution was superseded by cancellation."));
      this.activeOperation = undefined;
    }
    this.abortPreparationStages(new Error("Server runtime preparation was cancelled."));
    this.terminateActiveNativeRuns(new Error("Server execution was cancelled."));
  }

  async cancelAndWait(): Promise<void> {
    const completions = [...this.inFlightRuns].map((operation) => operation.completion);
    this.cancel();
    await Promise.all(completions);
  }

  restart(): void {
    this.assertActive();
    if (this.cacheClearActive) throw new Error("Cannot restart ServerRunner while clearing its cache.");
    this.cancel();
    this.packageCommands.clear();
    this.packageFileSystems.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation.cancel(new Error("Server execution was cancelled because its runner was disposed."));
      this.activeOperation = undefined;
    }
    this.abortPreparationStages(new Error("Server runtime preparation was cancelled because its runner was disposed."));
    this.terminateActiveNativeRuns(new Error("Server execution was cancelled because its runner was disposed."));
    this.progressListeners.clear();
    this.streamListeners.clear();
    this.packageCommands.clear();
    this.packageFileSystems.clear();
  }

  private async initialize(): Promise<void> {
    await access(this.runtimeExecutable, fsConstants.X_OK);
    await mkdir(this.cacheDirectory, { recursive: true });
    const resolvedCacheDirectory = await realpath(this.cacheDirectory);
    assertCacheDirectoryIsNotFilesystemRoot(resolvedCacheDirectory);
    this.resolvedCacheDirectory = resolvedCacheDirectory;
    await Promise.all(
      serverToolchainDirectories(this.toolchains).map((directory) => access(directory, fsConstants.R_OK)),
    );
  }

  private runtimeCacheDirectory(): string {
    if (!this.resolvedCacheDirectory) {
      throw new Error("ServerRunner runtime cache is not initialized.");
    }
    return this.resolvedCacheDirectory;
  }

  private resolver(operation: ServerRunOperation): RuntimeResolver {
    return {
      quickJs: () => operation.track(this.loadQuickJsForOperation(operation)),
      packageCommand: (packageSpecifier, commandName) =>
        this.packageCommand(operation, packageSpecifier, commandName),
      packageFileSystem: (request) => this.packageFileSystem(operation, request),
    };
  }

  private async prepareWithDeadline(
    operation: ServerRunOperation,
    artifact: BuildArtifact,
    config: RunConfig,
  ): Promise<PreparedRunRequest> {
    const timeoutMs = runtimePreparationTimeoutMs(artifact);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Server runtime preparation exceeded ${timeoutMs} ms.`,
        );
        operation.superseded = true;
        this.abortPreparationStages(error, operation);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        prepareArtifactRun(artifact, config, this.resolver(operation), this.runtimeDrivers),
        operation.cancellation,
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async prepareInteractiveWithDeadline(
    operation: ServerRunOperation,
    artifact: BuildArtifact,
    config: RunConfig,
  ): Promise<PreparedRunRequest> {
    const timeoutMs = runtimePreparationTimeoutMs(artifact);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Server interactive runtime preparation exceeded ${timeoutMs} ms.`,
        );
        operation.superseded = true;
        this.abortPreparationStages(error, operation);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        prepareArtifactInteraction(artifact, config, this.resolver(operation), this.runtimeDrivers),
        operation.cancellation,
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async prepareTrustedWithDeadline(
    operation: ServerRunOperation,
    program: TrustedJudgeProgram,
    config: RunConfig,
  ): Promise<PreparedRunRequest> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Trusted judge runtime preparation exceeded ${DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS} ms.`);
        operation.superseded = true;
        this.abortPreparationStages(error, operation);
        reject(error);
      }, DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => prepareTrustedJudgeRun(program, config)),
        operation.cancellation,
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async loadQuickJsForOperation(operation: ServerRunOperation): Promise<Uint8Array> {
    this.assertCurrent(operation, "Server execution was cancelled before QuickJS was loaded.");
    const bytes = await this.loadQuickJs();
    this.assertCurrent(operation, "Server execution was cancelled while QuickJS was loaded.");
    return bytes;
  }

  private async loadQuickJs(): Promise<Uint8Array> {
    return this.loadCompressedToolchainAsset(QUICKJS_ASSET_PATH, QUICKJS_ASSET_SHA256);
  }

  private packageCommand(
    operation: ServerRunOperation,
    packageSpecifier: string,
    command: string,
  ): Promise<Uint8Array> {
    this.assertPinnedPackageCommand(packageSpecifier, command);
    this.assertCurrent(operation, "Server execution was cancelled before its package command was loaded.");
    const identity = `${packageSpecifier}\n${command}`;
    let pending = this.packageCommands.get(identity);
    if (!pending) {
      const created = this.runPackageStage(operation, {
        operation: "command-binary",
        packageSpecifier,
        command,
      }).then((result) => {
        if (result.operation !== "command-binary") {
          throw new Error(`Runner stage returned '${result.operation}' for a command-binary request.`);
        }
        const verifiedBytes = new Uint8Array(result.bytes.byteLength);
        verifiedBytes.set(result.bytes);
        if (!WebAssembly.validate(verifiedBytes)) {
          throw new Error(`Package '${packageSpecifier}' command '${command}' returned invalid WebAssembly.`);
        }
        this.assertCurrent(operation, "Server execution was cancelled while its package command was loaded.");
        return verifiedBytes;
      });
      pending = created.catch((error) => {
        if (this.packageCommands.get(identity) === pending) this.packageCommands.delete(identity);
        throw error;
      });
      this.packageCommands.set(identity, pending);
    }
    return operation.track(pending.then((bytes) => bytes.slice()));
  }

  private assertPinnedPackageCommand(packageSpecifier: string, command: string): void {
    if (packageSpecifier !== PYTHON_PACKAGE || command !== "python") {
      throw new Error(
        `No pinned WASM-OJ runtime command is declared for '${packageSpecifier}:${command}'.`,
      );
    }
  }

  private async loadCompressedToolchainAsset(
    assetPath: string,
    compressedSha256: string,
    expandedSha256?: string,
  ): Promise<Uint8Array> {
    const file = serverToolchainAssetFile(this.toolchains, assetPath);
    const compressed = await readFile(file);
    if (!this.verifiedToolchain) this.verifyDigest(file, compressed, compressedSha256);
    const expandedBuffer = gunzipSync(compressed);
    const expanded = new Uint8Array(
      expandedBuffer.buffer,
      expandedBuffer.byteOffset,
      expandedBuffer.byteLength,
    );
    if (expandedSha256 && !this.verifiedToolchain) this.verifyDigest(file, expanded, expandedSha256);
    return expanded;
  }

  private verifyDigest(file: string, bytes: Uint8Array, expected: string): void {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(`Pinned toolchain asset '${file}' has digest ${actual}; expected ${expected}.`);
    }
  }

  private packageFileSystem(
    operation: ServerRunOperation,
    request: PackageFileSystemRequest,
  ): Promise<Record<string, Uint8Array>> {
    this.assertPinnedPackageCommand(request.packageSpecifier, request.command);
    this.assertCurrent(operation, "Server execution was cancelled before its runtime files were loaded.");
    const identity = `${request.packageSpecifier}\n${request.command}\n${request.cacheKey}\n${request.expectedSha256}`;
    let pending = this.packageFileSystems.get(identity);
    if (!pending) {
      const created = this.loadOrExportPackageFileSystem(operation, identity, request);
      pending = created.catch((error) => {
        if (this.packageFileSystems.get(identity) === pending) this.packageFileSystems.delete(identity);
        throw error;
      });
      this.packageFileSystems.set(identity, pending);
    }
    return operation.track(pending.then(cloneRuntimeFiles));
  }

  private async loadOrExportPackageFileSystem(
    operation: ServerRunOperation,
    identity: string,
    request: PackageFileSystemRequest,
  ): Promise<Record<string, Uint8Array>> {
    this.assertCurrent(operation, "Server execution was cancelled before its runtime cache was read.");
    const digest = createHash("sha256").update(identity).digest("hex");
    const cachePath = path.join(this.runtimeCacheDirectory(), `${digest}.wasmojfs`);
    const cachedArchive = await this.readRuntimeCacheArchive(cachePath);
    this.assertCurrent(operation, "Server execution was cancelled while its runtime cache was read.");
    if (cachedArchive) {
      try {
        return await verifyAndDecodeRuntimeFiles(cachedArchive, request.expectedSha256);
      } catch (error) {
        this.reportRuntimeCacheIssue("Ignoring an invalid runtime cache archive", error);
        await this.removeInvalidRuntimeCacheArchive(cachePath);
        this.assertCurrent(operation, "Server execution was cancelled while invalid runtime cache data was removed.");
      }
    }

    const result = await this.runPackageStage(operation, {
      operation: "runtime-files",
      packageSpecifier: request.packageSpecifier,
      command: request.command,
      args: [...request.args],
    });
    if (result.operation !== "runtime-files") {
      throw new Error(`Runner stage returned '${result.operation}' for a runtime-files request.`);
    }
    this.assertCurrent(operation, "Server execution was cancelled while its runtime files were exported.");
    const archive = result.bytes.slice();
    const files = await verifyAndDecodeRuntimeFiles(archive, request.expectedSha256);
    this.assertCurrent(operation, "Server execution was cancelled while its runtime files were verified.");
    await this.persistVerifiedRuntimeCacheArchive(cachePath, archive);
    this.assertCurrent(operation, "Server execution was cancelled while its runtime files were cached.");
    return files;
  }

  private async runPackageStage(
    operation: ServerRunOperation,
    request: RunnerStageRequest,
  ): Promise<RunnerStageResult> {
    this.assertCurrent(operation, "Server execution was cancelled before its runtime stage started.");
    const transportDirectory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-runner-response-"));
    const responsePath = path.join(transportDirectory, "response.v8");
    try {
      this.assertCurrent(operation, "Server execution was cancelled before its runtime stage spawned.");
      return await new Promise<RunnerStageResult>((resolve, reject) => {
        const script = serverStageScript(this.stageDirectory, SERVER_RUNNER_STAGE_SCRIPT);
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, WASM_OJ_RUNNER_STAGE_RESPONSE: responsePath },
          },
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const cleanup = (ignoreLateChildError: boolean) => {
          child.off("close", onClose);
          child.off("error", onChildError);
          child.stdin.off("error", onStdinError);
          child.stdout.off("data", onStdout);
          child.stderr.off("data", onStderr);
          this.activePreparationStages.delete(active);
          if (ignoreLateChildError) child.once("error", () => undefined);
        };
        const fail = (error: Error, kill: boolean) => {
          if (settled) return;
          settled = true;
          if (kill) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Rejection below is authoritative even if the process already exited.
            }
          }
          cleanup(kill);
          reject(error);
        };
        const succeed = (result: RunnerStageResult) => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve(result);
        };
        const capture = (
          chunks: Buffer[],
          chunk: Buffer,
          currentBytes: number,
          stream: "stdout" | "stderr",
        ): number => {
          const nextBytes = currentBytes + chunk.byteLength;
          if (nextBytes > MAX_RUNNER_STAGE_DIAGNOSTIC_BYTES) {
            fail(
              new Error(
                `The isolated server runtime stage exceeded its ${MAX_RUNNER_STAGE_DIAGNOSTIC_BYTES}-byte ${stream} limit.`,
              ),
              true,
            );
            return currentBytes;
          }
          chunks.push(chunk);
          return nextBytes;
        };
        const onStdout = (chunk: Buffer) => {
          stdoutBytes = capture(stdout, chunk, stdoutBytes, "stdout");
        };
        const onStderr = (chunk: Buffer) => {
          stderrBytes = capture(stderr, chunk, stderrBytes, "stderr");
        };
        const onChildError = (error: Error) => fail(error, true);
        const onStdinError = (error: Error) => fail(error, true);
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
          void (async () => {
            try {
              const response = await readRunnerStageResponse(responsePath, request.operation);
              this.assertCurrent(operation, "Server execution was cancelled while its runtime stage completed.");
              if (code !== 0 || signal) {
                throw new Error(
                  runnerStageDiagnostic(
                    stdout,
                    stderr,
                    `The isolated server runtime stage exited with ${signal ?? `code ${String(code)}`}.`,
                  ),
                );
              }
              succeed(response);
            } catch (error) {
              fail(
                new Error(
                  runnerStageDiagnostic(stdout, stderr, error instanceof Error ? error.message : String(error)),
                  { cause: error },
                ),
                false,
              );
            }
          })();
        };

        const active: ActivePreparationStage = {
          operation,
          abort: (error) => fail(error, true),
        };
        this.activePreparationStages.add(active);
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.on("error", onChildError);
        child.stdin.on("error", onStdinError);
        child.on("close", onClose);
        child.stdin.end(JSON.stringify({
          toolchainAsset: serverToolchainAssetFile(this.toolchains, PYTHON_PACKAGE_ASSET_PATH),
          verifiedToolchain: this.verifiedToolchain,
          request,
        }));
      });
    } finally {
      await rm(transportDirectory, { recursive: true, force: true });
    }
  }

  private async readRuntimeCacheArchive(cachePath: string): Promise<Uint8Array | undefined> {
    try {
      const status = await lstat(cachePath);
      if (!status.isFile()) {
        this.progress({
          phase: "restoring-cache",
          label: `Ignoring non-regular runtime cache entry '${cachePath}'.`,
        });
        return undefined;
      }
      if (status.size > MAX_RUNTIME_CACHE_ARCHIVE_BYTES) {
        this.progress({
          phase: "restoring-cache",
          label: `Removing oversized runtime cache archive '${cachePath}' (${status.size} bytes).`,
        });
        await this.removeInvalidRuntimeCacheArchive(cachePath);
        return undefined;
      }
      return new Uint8Array(
        await readBoundedRegularFile(cachePath, MAX_RUNTIME_CACHE_ARCHIVE_BYTES),
      );
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return undefined;
      this.reportRuntimeCacheIssue("Unable to read the runtime cache archive", error);
      await this.removeInvalidRuntimeCacheArchive(cachePath);
      return undefined;
    }
  }

  private async removeInvalidRuntimeCacheArchive(cachePath: string): Promise<void> {
    try {
      if ((await lstat(cachePath)).isFile()) await unlink(cachePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        this.reportRuntimeCacheIssue("Unable to remove the invalid runtime cache archive", error);
      }
    }
  }

  private async persistVerifiedRuntimeCacheArchive(cachePath: string, archive: Uint8Array): Promise<void> {
    const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, archive, { flag: "wx" });
      await rename(temporary, cachePath);
    } catch (error) {
      this.reportRuntimeCacheIssue("Unable to persist the verified runtime cache archive", error);
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!isFileSystemError(cleanupError, "ENOENT")) {
          this.reportRuntimeCacheIssue("Unable to remove a temporary runtime cache archive", cleanupError);
        }
      }
    }
  }

  private reportRuntimeCacheIssue(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.progress({ phase: "restoring-cache", label: `${action}: ${detail}` });
  }

  private runNativeCore(
    request: PreparedRunRequest,
    config: RunConfig,
    started: number,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.runtimeExecutable, [], { stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;
      const cleanup = (ignoreLateChildError: boolean) => {
        clearTimeout(timer);
        child.off("close", onClose);
        child.off("error", onChildError);
        child.stdin.off("error", onStdinError);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        this.activeNativeRuns.delete(active);
        if (ignoreLateChildError) child.once("error", () => undefined);
      };
      const fail = (error: Error, kill: boolean) => {
        if (settled) return;
        settled = true;
        if (kill) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Rejection below is authoritative even if the process already exited.
          }
        }
        cleanup(kill);
        reject(error);
      };
      const succeed = (result: RunResult, kill: boolean) => {
        if (settled) return;
        settled = true;
        if (kill) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The bounded result remains authoritative if the process already exited.
          }
        }
        cleanup(kill);
        resolve(result);
      };
      const stdout = new BoundedByteCollector(
        "Native runtime-core protocol stdout",
        nativeCoreResponseLimit(config.resources.outputLimitBytes),
        (error) => fail(error, true),
      );
      const stderr = new BoundedByteCollector(
        "Native runtime-core diagnostic stderr",
        MAX_NATIVE_CORE_DIAGNOSTIC_BYTES,
        (error) => fail(error, true),
      );
      const onStdout = (chunk: Buffer) => stdout.append(chunk);
      const onStderr = (chunk: Buffer) => stderr.append(chunk);
      const onChildError = (error: Error) => fail(error, true);
      const onStdinError = (error: Error) => fail(error, true);
      const onClose = () => {
        const durationMs = performance.now() - started;
        try {
          const output = stdout.text();
          const response = JSON.parse(output) as NativeCoreResponse;
          if (!response.ok || !response.result) {
            const error = response.error ?? {
              code: "RUNTIME_ERROR",
              message: stderr.text() || "Native runtime returned no result.",
            };
            throw Object.assign(new Error(error.message), { code: error.code });
          }
          const trapMessage = response.result.trapMessage;
          if (trapMessage !== undefined && trapMessage !== null && typeof trapMessage !== "string") {
            throw new Error("Native runtime returned an invalid trap message.");
          }
          succeed({
            code: response.result.code,
            stdout: Buffer.from(response.result.stdoutBase64, "base64").toString("utf8"),
            stderr: Buffer.from(response.result.stderrBase64, "base64").toString("utf8"),
            files: decodeNativeOutputFiles(response.result.filesBase64),
            durationMs,
            determinism: { ...config.determinism },
            resources: { ...config.resources },
            termination: response.result.termination,
            ...(typeof trapMessage === "string" ? { trapMessage } : {}),
            metrics: normalizeExecutionMetrics(response.result.metrics, request.cost),
          }, false);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)), false);
        }
      };
      const active: ActiveNativeRun = {
        child,
        abort: (error) => fail(error, true),
      };
      const timer = setTimeout(() => {
        succeed({
          code: 137,
          stdout: "",
          stderr: `Execution exceeded the ${config.resources.wallTimeLimitMs} ms wall deadline.`,
          files: {},
          durationMs: performance.now() - started,
          determinism: { ...config.determinism },
          resources: { ...config.resources },
          termination: "wall-time-limit",
          metrics: unavailableExecutionMetrics(request.cost, WEIGHTED_METER_MODEL),
        }, true);
      }, config.resources.wallTimeLimitMs);
      this.activeNativeRuns.add(active);
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", onChildError);
      child.stdin.on("error", onStdinError);
      child.on("close", onClose);
      child.stdin.end(JSON.stringify(encodeNativeRequest(request)));
    });
  }

  private runNativeInteractive(
    contestant: PreparedRunRequest,
    interactor: PreparedRunRequest,
    config: InteractiveRunConfig,
    started: number,
  ): Promise<InteractiveRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.runtimeExecutable, [], { stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;
      const cleanup = (ignoreLateChildError: boolean) => {
        clearTimeout(timer);
        child.off("close", onClose);
        child.off("error", onChildError);
        child.stdin.off("error", onStdinError);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        this.activeNativeRuns.delete(active);
        if (ignoreLateChildError) child.once("error", () => undefined);
      };
      const fail = (error: Error, kill: boolean) => {
        if (settled) return;
        settled = true;
        if (kill) child.kill("SIGKILL");
        cleanup(kill);
        reject(error);
      };
      const succeed = (result: InteractiveRunResult, kill: boolean) => {
        if (settled) return;
        settled = true;
        if (kill) child.kill("SIGKILL");
        cleanup(kill);
        resolve(result);
      };
      const combinedOutputLimit = contestant.resources.outputLimitBytes
        + interactor.resources.outputLimitBytes;
      const stdout = new BoundedByteCollector(
        "Native interactive protocol stdout",
        nativeCoreResponseLimit(combinedOutputLimit),
        (error) => fail(error, true),
      );
      const stderr = new BoundedByteCollector(
        "Native interactive diagnostic stderr",
        MAX_NATIVE_CORE_DIAGNOSTIC_BYTES,
        (error) => fail(error, true),
      );
      const onStdout = (chunk: Buffer) => stdout.append(chunk);
      const onStderr = (chunk: Buffer) => stderr.append(chunk);
      const onChildError = (error: Error) => fail(error, true);
      const onStdinError = (error: Error) => fail(error, true);
      const onClose = () => {
        try {
          const response = JSON.parse(stdout.text()) as NativeInteractiveResponse;
          if (!response.ok || !response.result) {
            const error = response.error ?? {
              code: "RUNTIME_ERROR",
              message: stderr.text() || "Native interactive runtime returned no result.",
            };
            throw Object.assign(new Error(error.message), { code: error.code });
          }
          succeed({
            contestant: nativeInteractiveProcess(response.result.contestant, contestant),
            interactor: nativeInteractiveProcess(response.result.interactor, interactor),
            contestantToInteractor: Buffer.from(
              response.result.contestantToInteractorBase64,
              "base64",
            ).toString("utf8"),
            interactorToContestant: Buffer.from(
              response.result.interactorToContestantBase64,
              "base64",
            ).toString("utf8"),
            durationMs: performance.now() - started,
            determinism: { ...config.determinism },
          }, false);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)), false);
        }
      };
      const active: ActiveNativeRun = { child, abort: (error) => fail(error, true) };
      const wallTimeLimitMs = Math.min(
        config.contestant.resources.wallTimeLimitMs,
        config.interactor.resources.wallTimeLimitMs,
      );
      const timer = setTimeout(() => {
        const message = `Interactive execution exceeded the ${wallTimeLimitMs} ms wall deadline.`;
        succeed({
          contestant: {
            code: 137,
            stderr: message,
            termination: "wall-time-limit",
            metrics: unavailableExecutionMetrics(contestant.cost, WEIGHTED_METER_MODEL),
          },
          interactor: {
            code: 137,
            stderr: message,
            termination: "wall-time-limit",
            metrics: unavailableExecutionMetrics(interactor.cost, WEIGHTED_METER_MODEL),
          },
          contestantToInteractor: "",
          interactorToContestant: "",
          durationMs: performance.now() - started,
          determinism: { ...config.determinism },
        }, true);
      }, wallTimeLimitMs);
      this.activeNativeRuns.add(active);
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", onChildError);
      child.stdin.on("error", onStdinError);
      child.on("close", onClose);
      child.stdin.end(JSON.stringify(encodeNativeInteractiveRequest(contestant, interactor, config)));
    });
  }

  private progress(progress: WorkerProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }

  private stream(stream: "stdout" | "stderr", chunk: string): void {
    for (const listener of this.streamListeners) listener(stream, chunk);
  }

  private assertCurrent(operation: ServerRunOperation, message: string): void {
    this.assertActive();
    if (operation.superseded || operation.generation !== this.generation) throw new Error(message);
  }

  private abortPreparationStages(error: Error, operation?: ServerRunOperation): void {
    for (const active of [...this.activePreparationStages]) {
      if (!operation || active.operation === operation) active.abort(error);
    }
  }

  private terminateActiveNativeRuns(error: Error): void {
    for (const active of [...this.activeNativeRuns]) active.abort(error);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ServerRunner is disposed.");
  }

  private assertArtifactToolchain(artifact: BuildArtifact): void {
    assertServerToolchainProfile(
      this.toolchains,
      artifact.language,
      artifact.target,
      artifact.optimization,
    );
  }
}

function createServerRunOperation(generation: number): ServerRunOperation {
  let rejectCancellation!: (error: Error) => void;
  let resolveCompletion!: () => void;
  let cancelled = false;
  let completed = false;
  const tasks = new Set<Promise<void>>();
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => undefined);
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    generation,
    superseded: false,
    cancellation,
    cancel(error) {
      if (cancelled) return;
      cancelled = true;
      rejectCancellation(error);
    },
    track<T>(task: Promise<T>): Promise<T> {
      const settled = task.then(() => undefined, () => undefined);
      tasks.add(settled);
      void settled.then(() => tasks.delete(settled));
      return task;
    },
    async quiesce(): Promise<void> {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
    completion,
    complete() {
      if (completed) return;
      completed = true;
      resolveCompletion();
    },
  };
}

async function readRunnerStageResponse(
  responsePath: string,
  expectedOperation: RunnerStageRequest["operation"],
): Promise<RunnerStageResult> {
  const encoded = await readBoundedRegularFile(responsePath, MAX_RUNNER_STAGE_RESPONSE_BYTES);
  if (encoded.byteLength === 0) throw new Error("The isolated server runtime stage returned an empty response.");
  const response: unknown = deserialize(encoded);
  if (!isRecord(response) || typeof response.ok !== "boolean") {
    throw new Error("The isolated server runtime stage returned an invalid response envelope.");
  }
  if (!response.ok) {
    if (typeof response.error !== "string" || response.error.length === 0) {
      throw new Error("The isolated server runtime stage failed without an error message.");
    }
    throw new Error(response.error);
  }
  if (!isRecord(response.result)) {
    throw new Error("The isolated server runtime stage returned no result.");
  }
  const operation = response.result.operation;
  const bytes = response.result.bytes;
  if (operation !== expectedOperation) {
    throw new Error(
      `The isolated server runtime stage returned '${String(operation)}' for '${expectedOperation}'.`,
    );
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("The isolated server runtime stage returned non-binary result bytes.");
  }
  return { operation: expectedOperation, bytes: bytes.slice() };
}

function nativeCoreResponseLimit(outputLimitBytes: number): number {
  return Math.ceil(outputLimitBytes / 3) * 4 + NATIVE_CORE_RESPONSE_OVERHEAD_BYTES;
}

function runnerStageDiagnostic(stdout: Buffer[], stderr: Buffer[], summary: string): string {
  const stageDiagnostic = Buffer.concat(stderr).toString("utf8").trim()
    || Buffer.concat(stdout).toString("utf8").trim();
  return stageDiagnostic ? `${summary}\n${stageDiagnostic}` : summary;
}

function cloneRuntimeFiles(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(files).map(([filePath, contents]) => [filePath, contents.slice()]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeNativeRequest(request: PreparedRunRequest) {
  return {
    schema: WASM_OJ_SCHEMAS.runRequest,
    wasmBase64: Buffer.from(request.wasm).toString("base64"),
    args: request.args,
    env: request.env,
    stdinBase64: Buffer.from(request.stdin).toString("base64"),
    filesBase64: Object.fromEntries(
      Object.entries(request.files).map(([filePath, contents]) => [
        filePath,
        Buffer.from(contents).toString("base64"),
      ]),
    ),
    outputPaths: request.outputPaths,
    cwd: request.cwd,
    startupEntropyBytes: request.startupEntropyBytes,
    determinism: request.determinism,
    resources: request.resources,
  };
}

function interactiveRunConfig(
  program: InteractiveRunConfig["contestant"],
  determinism: InteractiveRunConfig["determinism"],
): RunConfig {
  return {
    args: [...program.args],
    stdin: "",
    env: { ...program.env },
    files: Object.fromEntries(Object.entries(program.files ?? {}).map(([path, contents]) => [
      path,
      contents.slice(),
    ])),
    outputPaths: [],
    ...(program.cwd === undefined ? {} : { cwd: program.cwd }),
    determinism: { ...determinism },
    resources: { ...program.resources },
  };
}

function encodeNativeInteractiveRequest(
  contestant: PreparedRunRequest,
  interactor: PreparedRunRequest,
  config: InteractiveRunConfig,
) {
  return {
    schema: WASM_OJ_SCHEMAS.interactiveRequest,
    contestant: encodeNativeInteractiveProgram(contestant),
    interactor: encodeNativeInteractiveProgram(interactor),
    determinism: config.determinism,
  };
}

function encodeNativeInteractiveProgram(request: PreparedRunRequest) {
  return {
    wasmBase64: Buffer.from(request.wasm).toString("base64"),
    args: request.args,
    env: request.env,
    filesBase64: Object.fromEntries(Object.entries(request.files).map(([filePath, contents]) => [
      filePath,
      Buffer.from(contents).toString("base64"),
    ])),
    cwd: request.cwd,
    startupEntropyBytes: request.startupEntropyBytes,
    resources: request.resources,
  };
}

function nativeInteractiveProcess(
  result: NativeInteractiveProcessResult,
  prepared: PreparedRunRequest,
): InteractiveProcessResult {
  const metrics = normalizeExecutionMetrics({
    cost: result.metrics.cost,
    costModel: WEIGHTED_METER_MODEL,
    operations: result.metrics.operations,
    memoryBytes: 0,
    logicalTimeNs: result.metrics.logicalTimeNs,
    filesystemBytes: result.metrics.filesystemBytes,
    filesystemEntries: result.metrics.filesystemEntries,
    stdoutBytes: result.metrics.protocolBytes,
    stderrBytes: result.metrics.stderrBytes,
  }, prepared.cost);
  return {
    code: result.code,
    stderr: Buffer.from(result.stderrBase64, "base64").toString("utf8"),
    termination: result.termination,
    metrics: { ...metrics, memoryBytes: null },
  };
}

function decodeNativeOutputFiles(value: unknown): Record<string, Uint8Array> {
  if (!isRecord(value) || Object.keys(value).length > 256) {
    throw new Error("Native runtime returned an invalid output file record.");
  }
  const files: Record<string, Uint8Array> = {};
  for (const [path, encoded] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof encoded !== "string") throw new Error(`Native runtime output file '${path}' is not base64 text.`);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error(`Native runtime output file '${path}' has non-canonical base64.`);
    files[path] = new Uint8Array(bytes);
  }
  return files;
}

function assertCacheDirectoryIsNotFilesystemRoot(directory: string): void {
  if (directory === path.parse(directory).root) {
    throw new Error("ServerRunner cacheDirectory must not be a filesystem root.");
  }
}

function isWasmOjRuntimeCacheFile(name: string): boolean {
  return WASM_OJ_RUNTIME_CACHE_FILE.test(name) || WASM_OJ_RUNTIME_CACHE_TEMPORARY_FILE.test(name);
}

async function removeWasmOjRuntimeCacheFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isFile() || !isWasmOjRuntimeCacheFile(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      if (!(await lstat(file)).isFile()) continue;
      await unlink(file);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
