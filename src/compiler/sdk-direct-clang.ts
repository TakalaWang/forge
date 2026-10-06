import type { Package, Sandbox, Wasmer } from "@wasmer/sdk";
import { WASM_OJ_CONTRACT_VERSION } from "../core/contract.ts";
import {
  decodeClangPins,
  instantiateClangCc1,
  instantiateClangLink,
  instantiateClangPch,
  type ClangPins,
} from "./clang-pins.ts";
import { ClangObjectCache, parseClangDependencyFile } from "./clang-object-cache.ts";
import { costProfileId } from "../core/cost-profile.ts";
import { ensureFailureDiagnostic, parseClangDiagnostics } from "../core/diagnostics.ts";
import {
  CLANG_CC1_PINS_ASSET_PATH,
  CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH,
  CLANG_PACKAGE_ASSET_PATH,
  CLANG_PACKAGE_SHA256,
  toolchainPackageIdentities,
} from "../core/toolchains.ts";
import {
  decodeLibcxxPchManifest,
  isToolchainLibcxxPchHeader,
  type LibcxxPchManifest,
  type LibcxxPchProfile,
} from "./libcxx-pch.ts";
import { sha256Hex } from "../core/hash.ts";
import type { BuildGraphInput } from "./incremental-build-graph.ts";
import type { IncrementalBuildGraphState } from "./incremental-build-graph.ts";
import type {
  BuildResult,
  CompilerTraceEvent,
  CompilerTraceOperation,
  Diagnostic,
  Project,
  WasmArtifact,
  WorkerPhase,
} from "../core/types.ts";
import {
  DETERMINISTIC_NATIVE_RUNTIME,
  DETERMINISTIC_NATIVE_SOURCE_PATH,
} from "../runtime/determinism.ts";
import { cppDependencyInput } from "./dependency-input.ts";
import { runSandboxCommand } from "./sandbox-command.ts";

export interface SdkDirectClangHost {
  wasmer: Wasmer;
  loadToolchainAsset(path: string): Promise<Uint8Array>;
  loadToolchainFile(path: string): Promise<Uint8Array>;
  progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void;
  trace(requestId: string, operation: CompilerTraceOperation, state: CompilerTraceEvent["state"]): void;
}

interface LoadedToolchain {
  pkg: Package;
  pins: ClangPins;
}

let loadedToolchain: { wasmer: Wasmer; toolchain: Promise<LoadedToolchain> } | undefined;
let loadedLibcxxPchManifest: Promise<LibcxxPchManifest> | undefined;
const loadedLibcxxPch = new Map<LibcxxPchProfile, Promise<Uint8Array>>();
const objectCache = new ClangObjectCache(64 * 1024 * 1024);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STAGE_OUTPUT_TIMEOUT_MS = 55_000;
const GUEST_ROOT = "/workspace";
// The pinned argv and the admitted libc++ PCH name `/project`; SDK sandboxes keep files in `/workspace`.
const PINNED_GUEST_ROOT = "/project";
// The admitted libc++ PCH asset records its header at the pinned `/project` path.
const LIBCXX_PCH_OVERLAY_PATH = `${GUEST_ROOT}/.wasm-oj/libcxx-pch-overlay.yaml`;
const PREFIX_MAPS = [
  `-fmacro-prefix-map=${GUEST_ROOT}/=${PINNED_GUEST_ROOT}/`,
  `-fdebug-prefix-map=${GUEST_ROOT}/=${PINNED_GUEST_ROOT}/`,
];

interface ClangStageResult {
  diagnostics: Diagnostic[];
  object?: Uint8Array;
  dependency?: Uint8Array;
  stdout: string;
  stderr: string;
}

interface ClangPchStageResult {
  diagnostics: Diagnostic[];
  pch?: Uint8Array;
  dependency?: Uint8Array;
  stdout: string;
  stderr: string;
}

interface StageObservation<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Compiler that drives the pinned cc1 and wasm-ld jobs through the official
 * SDK, one sandbox per build. No Clang driver or guest subprocess is involved.
 */
export async function buildClangWithSdkDirect(
  project: Project,
  cacheKey: string,
  requestId: string,
  host: SdkDirectClangHost,
): Promise<BuildResult> {
  if (project.config.target !== "wasip1" && project.config.target !== "wasix") {
    throw new Error("The output-ready Clang compiler accepts only wasip1 or wasix targets.");
  }
  if (project.config.language !== "c" && project.config.language !== "cpp") {
    throw new Error("The output-ready Clang compiler accepts only C and C++ projects.");
  }

  const started = performance.now();
  host.progress(requestId, "loading-toolchain", "Loading pinned Clang 22 toolchain", 0.15);
  const { pins, pkg } = await ensureToolchain(requestId, host);
  const configKey = `${project.config.language}-${project.config.optimization}`;
  const config = pins.configs[configKey];
  if (!config) throw new Error(`The pinned Clang manifest has no '${configKey}' configuration.`);
  host.trace(requestId, "filesystemPrepare", "start");
  const projectFiles = new Map<string, Uint8Array>(
    project.files.map((file) => [file.path, encoder.encode(file.content)]),
  );
  const dependencies = cppDependencyInput(project);
  for (const [path, bytes] of dependencies.files) projectFiles.set(path, bytes);
  projectFiles.set(DETERMINISTIC_NATIVE_SOURCE_PATH, encoder.encode(DETERMINISTIC_NATIVE_RUNTIME));
  const sandbox = await host.wasmer.sandboxes.create({
    packages: [pkg],
    files: Object.fromEntries([...projectFiles].map(([path, bytes]) => [`${GUEST_ROOT}/${path}`, bytes])),
    env: {
      PATH: "/bin",
      SOURCE_DATE_EPOCH: "946684800",
      TZ: "UTC",
      LC_ALL: "C",
    },
  });
  const stages = { compiler: pins.command, linker: pins.linkerCommand, sandbox, abandoned: false };
  try {
    await sandbox.fs.mkdir(`${GUEST_ROOT}/build`, { recursive: true });
    await sandbox.fs.mkdir(`${GUEST_ROOT}/.wasm-oj`, { recursive: true });
    host.trace(requestId, "filesystemPrepare", "end");

  const isCpp = project.config.language === "cpp";
  const extensions = isCpp ? /\.(?:cc|cpp|cxx)$/ : /\.c$/;
  const sources = project.files.filter((file) => extensions.test(file.path)).map((file) => file.path);
  if (!sources.includes(project.config.entry)) sources.unshift(project.config.entry);
  const units = [...sources, ...dependencies.sources, DETERMINISTIC_NATIVE_SOURCE_PATH];
  let stdout = "";
  let stderr = "";
  const objectPaths: string[] = [];
  const objectInputs: BuildGraphInput[] = [];
  let objectCacheHits = 0;
  let objectCacheStores = 0;
  let pchHits = 0;
  let pchMisses = 0;
  let pchStores = 0;
  let linkHits = 0;
  let linkMisses = 0;
  let linkStores = 0;
  const structuredDiagnostics: Diagnostic[] = [];

  const pchHeader = isCpp ? findPrecompiledHeader(project) : undefined;
  const pchPath = `${GUEST_ROOT}/build/wasm-oj.pch`;
  let pchInput: BuildGraphInput | undefined;
  let admittedPch = false;
  if (pchHeader) {
    const headerBytes = projectFiles.get(pchHeader)!;
    let pch: Uint8Array;
    if (isToolchainLibcxxPchHeader(decoder.decode(headerBytes))) {
      admittedPch = true;
      const reservedHeader = "wasm-oj.libcxx.hpp";
      if (projectFiles.has(reservedHeader)) {
        throw new Error(`C++ projects using WASM-OJ's admitted libc++ PCH may not define reserved path '${reservedHeader}'.`);
      }
      projectFiles.set(reservedHeader, headerBytes);
      await sandbox.fs.writeFile(`${GUEST_ROOT}/${reservedHeader}`, headerBytes);
      await sandbox.fs.writeText(LIBCXX_PCH_OVERLAY_PATH, JSON.stringify({
        version: 0,
        "case-sensitive": "true",
        roots: [{
          type: "directory",
          name: PINNED_GUEST_ROOT,
          contents: [{ type: "file", name: reservedHeader, "external-contents": `${GUEST_ROOT}/${reservedHeader}` }],
        }],
      }));
      pch = await loadLibcxxPch(configKey as LibcxxPchProfile, requestId, host);
      pchHits += 1;
      await sandbox.fs.writeFile(pchPath, pch);
    } else {
      const baseKey = await objectCache.unitManifestKey(pins, configKey, pchHeader, headerBytes);
      // A PCH records absolute input paths, so entries built under another root never match.
      const pchManifestKey = await sha256Hex(JSON.stringify({ baseKey, mode: "c++-header", root: GUEST_ROOT }));
      const cached = await objectCache.lookupPch(pchManifestKey, projectFiles);
      if (cached) {
        pch = cached;
        pchHits += 1;
        await sandbox.fs.writeFile(pchPath, pch);
      } else {
        pchMisses += 1;
        const dependencyPath = `${GUEST_ROOT}/build/wasm-oj.pch.d`;
        const args = instantiateClangPch(config.cc1, pins.placeholders, pchHeader, pchPath);
        args.splice(args.length - 1, 0, ...dependencies.includeDirectories.flatMap((directory) => ["-I", directory]));
        args.push("-dependency-file", dependencyPath, "-MT", pchPath);
        const output = await runPchStage(
          stages,
          args,
          host,
          requestId,
          pchPath,
          dependencyPath,
        );
        structuredDiagnostics.push(...output.diagnostics);
        stdout += output.stdout;
        stderr += output.stderr;
        if (!output.pch || !output.dependency) {
          return failedBuild(project, stdout, stderr, 1, "clang", structuredDiagnostics);
        }
        pch = output.pch;
        if (await objectCache.storePch(
          pchManifestKey,
          parseClangDependencyFile(output.dependency),
          projectFiles,
          pch,
        )) pchStores += 1;
      }
    }
    pchInput = { kind: "pch", identity: `pch:${pchHeader}`, digest: await sha256Hex(pch) };
  }

  host.progress(requestId, "compiling", `Compiling ${units.length} translation units with SDK-direct cc1`, 0.35);
  host.trace(requestId, "commandStart", "start");
  host.trace(requestId, "commandStart", "end");
  host.trace(requestId, "commandWait", "start");
  host.trace(requestId, "projectCompile", "start");
  for (const [index, source] of units.entries()) {
    if (source === DETERMINISTIC_NATIVE_SOURCE_PATH) {
      host.trace(requestId, "projectCompile", "end");
      host.trace(requestId, "runtimeShimCompile", "start");
    }
    const objectPath = `${GUEST_ROOT}/build/${String(index).padStart(4, "0")}.o`;
    const dependencyPath = `${GUEST_ROOT}/build/${String(index).padStart(4, "0")}.d`;
    const sourceBytes = projectFiles.get(source);
    if (!sourceBytes) throw new Error(`SDK-direct Clang is missing source bytes for '${source}'.`);
    const baseManifestKey = await objectCache.unitManifestKey(pins, configKey, source, sourceBytes);
    const unitPchInput = source !== DETERMINISTIC_NATIVE_SOURCE_PATH ? pchInput : undefined;
    const manifestKey = unitPchInput
      ? await sha256Hex(JSON.stringify({ baseManifestKey, pch: unitPchInput.digest }))
      : baseManifestKey;
    const additionalInputs = unitPchInput ? [unitPchInput] : [];
    const cached = await objectCache.lookup(manifestKey, projectFiles, additionalInputs);
    if (cached) {
      await sandbox.fs.writeFile(objectPath, cached);
      objectCacheHits += 1;
      objectPaths.push(objectPath);
      objectInputs.push({ kind: "object", identity: source, bytes: cached });
      continue;
    }
    const args = instantiateClangCc1(config.cc1, pins.placeholders, source, objectPath);
    args.splice(args.length - 1, 0, ...dependencies.includeDirectories.flatMap((directory) => ["-I", directory]));
    if (unitPchInput) {
      args.splice(
        args.length - 1,
        0,
        "-include-pch",
        pchPath,
        ...(admittedPch ? ["-fno-validate-pch", "-ivfsoverlay", LIBCXX_PCH_OVERLAY_PATH] : []),
      );
    }
    args.push("-dependency-file", dependencyPath, "-MT", objectPath);
    const output = await runClangStage(
      stages,
      args,
      host,
      requestId,
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimSpawn" : "projectSpawn",
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimWait" : "projectWait",
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimOutputReady" : "projectOutputReady",
      objectPath,
      dependencyPath,
    );
    structuredDiagnostics.push(...output.diagnostics);
    stdout += output.stdout;
    stderr += output.stderr;
    if (!output.object || !output.dependency) {
      host.trace(
        requestId,
        source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimCompile" : "projectCompile",
        "end",
      );
      host.trace(requestId, "commandWait", "end");
      return failedBuild(project, stdout, stderr, 1, "clang", structuredDiagnostics);
    }
    // A cached unit cannot recreate compiler warnings without rerunning cc1.
    // Cache only diagnostically clean output so cache hits preserve BuildResult.
    if (output.diagnostics.length === 0 && await objectCache.store(
      manifestKey,
      parseClangDependencyFile(output.dependency),
      projectFiles,
      output.object,
      additionalInputs,
    )) {
      objectCacheStores += 1;
    }
    objectPaths.push(objectPath);
    objectInputs.push({ kind: "object", identity: source, bytes: output.object });
  }
  host.trace(requestId, "runtimeShimCompile", "end");

  host.progress(requestId, "linking", "Linking SDK-direct Clang objects", 0.8);
  host.trace(requestId, "link", "start");
  const outputPath = `${GUEST_ROOT}/build/app.wasm`;
  const linkArguments = instantiateClangLink(config.link, pins.placeholders, objectPaths, outputPath);
  const linkManifestKey = await sha256Hex(JSON.stringify({
    pins: pins.sourceSha256,
    package: CLANG_PACKAGE_SHA256,
    target: project.config.target,
    arguments: config.link,
  }));
  let bytes = await objectCache.lookupLink(linkManifestKey, objectInputs);
  let linkedStdout = "";
  let linkedStderr = "";
  if (bytes) {
    linkHits += 1;
  } else {
    linkMisses += 1;
    const linked = await runLinkStage(
      stages,
      linkArguments,
      host,
      requestId,
      "linkSpawn",
      "linkWait",
      "linkOutputReady",
      outputPath,
    );
    linkedStdout = linked.stdout;
    linkedStderr = linked.stderr;
    bytes = linked.value;
    if (bytes && await objectCache.storeLink(linkManifestKey, objectInputs, bytes)) linkStores += 1;
  }
  host.trace(requestId, "link", "end");
  host.trace(requestId, "commandWait", "end");
  stdout += linkedStdout;
  stderr += linkedStderr;
  if (!bytes) return failedBuild(project, stdout, stderr, 1, "wasm-ld", structuredDiagnostics);

  host.progress(requestId, "linking", "Reading linked WebAssembly module", 0.95);
  host.trace(requestId, "artifactReadback", "start");
  host.trace(requestId, "artifactReadback", "end");
  const diagnostics = structuredDiagnostics;
  const artifact: WasmArtifact = {
    kind: "wasm",
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    id: crypto.randomUUID(),
    projectId: project.id,
    cacheKey,
    name: `${project.name}.wasm`,
    language: project.config.language,
    target: project.config.target,
    optimization: project.config.optimization,
    createdAt: Date.now(),
    durationMs: performance.now() - started,
    size: bytes.byteLength,
    toolchains: toolchainPackageIdentities(project.config.language),
    costProfile: costProfileId(project.config.language, project.config.target, project.config.optimization),
    ...(project.dependencies === undefined ? {} : { dependencyLockSha256: project.dependencies.lockSha256 }),
    bytes,
  };
    return {
      success: true,
      diagnostics,
      artifact,
      stdout,
      stderr,
      cacheHit: false,
      buildGraph: {
        hits: { pch: pchHits, object: objectCacheHits, "link-result": linkHits },
        misses: { pch: pchMisses, object: units.length - objectCacheHits, "link-result": linkMisses },
        stores: { pch: pchStores, object: objectCacheStores, "link-result": linkStores },
      },
    };
  } finally {
    if (!stages.abandoned) await sandbox.close();
  }
}

export async function clearSdkDirectClangCaches(): Promise<void> {
  await disposeSdkDirectClangToolchain();
  loadedLibcxxPchManifest = undefined;
  loadedLibcxxPch.clear();
  objectCache.clear();
}

export function exportSdkDirectClangBuildGraphState(): IncrementalBuildGraphState {
  return objectCache.exportState();
}

export function restoreSdkDirectClangBuildGraphState(state: IncrementalBuildGraphState): Promise<void> {
  return objectCache.restoreState(state);
}

/** Forget the package loaded into one SDK client while preserving object-cache bytes. */
export async function disposeSdkDirectClangToolchain(): Promise<void> {
  loadedToolchain = undefined;
}

async function ensureToolchain(
  requestId: string,
  host: SdkDirectClangHost,
): Promise<LoadedToolchain> {
  if (loadedToolchain?.wasmer === host.wasmer) {
    for (const operation of ["toolchainFetch", "toolchainDecode", "toolchainLoad"] as const) {
      host.trace(requestId, operation, "start");
      host.trace(requestId, operation, "end");
    }
    return loadedToolchain.toolchain;
  }
  const pending = (async () => {
    host.trace(requestId, "toolchainFetch", "start");
    const [packageBytes, pinsBytes] = await Promise.all([
      host.loadToolchainAsset(CLANG_PACKAGE_ASSET_PATH),
      host.loadToolchainFile(CLANG_CC1_PINS_ASSET_PATH),
    ]);
    host.trace(requestId, "toolchainFetch", "end");
    host.trace(requestId, "toolchainDecode", "start");
    const pins = await decodeClangPins(pinsBytes);
    const packageSha256 = await sha256Hex(packageBytes);
    if (packageSha256 !== CLANG_PACKAGE_SHA256) {
      throw new Error(`Pinned Clang package digest mismatch: received ${packageSha256}.`);
    }
    host.trace(requestId, "toolchainDecode", "end");
    host.trace(requestId, "toolchainLoad", "start");
    const pkg = await host.wasmer.packages.load(packageBytes);
    for (const command of [pins.command, pins.linkerCommand]) {
      if (!pkg.commands.includes(command)) {
        throw new Error(`The SDK-direct Clang package does not expose '${command}'.`);
      }
    }
    host.trace(requestId, "toolchainLoad", "end");
    return { pkg, pins };
  })();
  const entry = { wasmer: host.wasmer, toolchain: pending };
  loadedToolchain = entry;
  try {
    return await pending;
  } catch (error) {
    if (loadedToolchain === entry) loadedToolchain = undefined;
    throw error;
  }
}

async function loadLibcxxPch(
  profile: LibcxxPchProfile,
  requestId: string,
  host: SdkDirectClangHost,
): Promise<Uint8Array> {
  loadedLibcxxPchManifest ??= host.loadToolchainFile(CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH)
    .then(decodeLibcxxPchManifest);
  let pending = loadedLibcxxPch.get(profile);
  if (!pending) {
    pending = loadedLibcxxPchManifest.then(async (manifest) => {
      const asset = manifest.profiles[profile];
      host.progress(requestId, "loading-toolchain", `Loading admitted libc++ PCH (${profile})`, 0.25);
      const bytes = await host.loadToolchainAsset(`/toolchains/${asset.path}`);
      if (bytes.byteLength !== asset.byteLength || await sha256Hex(bytes) !== asset.sha256) {
        throw new Error(`Pinned libc++ PCH '${profile}' failed decompressed integrity verification.`);
      }
      return bytes;
    });
    loadedLibcxxPch.set(profile, pending);
  }
  try {
    return await pending;
  } catch (error) {
    loadedLibcxxPch.delete(profile);
    throw error;
  }
}

function findPrecompiledHeader(project: Project): string | undefined {
  const headers = project.files
    .map((file) => file.path)
    .filter((path) => path.split("/").at(-1) === "wasm-oj.pch.hpp");
  if (headers.length > 1) {
    throw new Error(`C++ projects may contain at most one wasm-oj.pch.hpp; received ${headers.join(", ")}.`);
  }
  return headers[0];
}

interface ClangStages {
  compiler: string;
  linker: string;
  sandbox: Sandbox;
  abandoned: boolean;
}

async function runPchStage(
  stages: ClangStages,
  args: string[],
  host: SdkDirectClangHost,
  requestId: string,
  outputPath: string,
  dependencyPath: string,
): Promise<ClangPchStageResult> {
  const observed = await runStage(
    stages,
    stages.compiler,
    [...guestArguments(args), ...PREFIX_MAPS],
    host,
    requestId,
    "projectSpawn",
    "projectWait",
    "projectOutputReady",
    async (succeeded) => {
      if (!succeeded) return {};
      const [pch, dependency] = await Promise.all([
        readOptionalFile(stages.sandbox, outputPath),
        readOptionalFile(stages.sandbox, dependencyPath),
      ]);
      return pch?.byteLength && dependency?.byteLength ? { pch, dependency } : {};
    },
  );
  return {
    ...observed.value,
    diagnostics: parseClangDiagnostics(`${observed.stderr}\n${observed.stdout}`),
    stdout: observed.stdout,
    stderr: observed.stderr,
  };
}

async function runClangStage(
  stages: ClangStages,
  args: string[],
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  outputPath: string,
  dependencyPath: string,
): Promise<ClangStageResult> {
  const observed = await runStage(
    stages,
    stages.compiler,
    [...guestArguments(args), ...PREFIX_MAPS],
    host,
    requestId,
    spawnOperation,
    waitOperation,
    outputReadyOperation,
    async (succeeded) => {
      if (!succeeded) return {};
      const [object, dependency] = await Promise.all([
        readValidWasmFile(stages.sandbox, outputPath),
        readOptionalFile(stages.sandbox, dependencyPath),
      ]);
      return object && dependency?.byteLength ? { object, dependency } : {};
    },
  );
  return {
    ...observed.value,
    diagnostics: parseClangDiagnostics(`${observed.stderr}\n${observed.stdout}`),
    stdout: observed.stdout,
    stderr: observed.stderr,
  };
}

function runLinkStage(
  stages: ClangStages,
  args: string[],
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  outputPath: string,
): Promise<StageObservation<Uint8Array | undefined>> {
  return runStage(
    stages,
    stages.linker,
    guestArguments(args),
    host,
    requestId,
    spawnOperation,
    waitOperation,
    outputReadyOperation,
    async (succeeded) => succeeded ? readValidWasmFile(stages.sandbox, outputPath) : undefined,
  );
}

async function runStage<T>(
  stages: ClangStages,
  command: string,
  args: string[],
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  readOutput: (succeeded: boolean) => Promise<T>,
): Promise<StageObservation<T>> {
  host.trace(requestId, spawnOperation, "start");
  const running = runSandboxCommand(stages.sandbox, stages, {
    command,
    args,
    cwd: GUEST_ROOT,
    timeoutMs: STAGE_OUTPUT_TIMEOUT_MS,
    timeoutMessage: `Compiler stage did not complete within ${STAGE_OUTPUT_TIMEOUT_MS} ms.`,
  });
  host.trace(requestId, spawnOperation, "end");
  host.trace(requestId, waitOperation, "start");
  host.trace(requestId, outputReadyOperation, "start");
  try {
    const output = await running;
    return {
      value: await readOutput(output.ok),
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  } finally {
    host.trace(requestId, outputReadyOperation, "end");
    host.trace(requestId, waitOperation, "end");
  }
}

function guestArguments(args: readonly string[]): string[] {
  return args.map((argument) => (
    argument === PINNED_GUEST_ROOT || argument.startsWith(`${PINNED_GUEST_ROOT}/`)
      ? `${GUEST_ROOT}${argument.slice(PINNED_GUEST_ROOT.length)}`
      : argument
  ));
}

async function readValidWasmFile(sandbox: Sandbox, guestPath: string): Promise<Uint8Array | undefined> {
  const bytes = await readOptionalFile(sandbox, guestPath);
  if (!bytes || bytes.byteLength <= 8) return undefined;
  const copy = new Uint8Array(bytes);
  return WebAssembly.validate(copy) ? copy : undefined;
}

async function readOptionalFile(sandbox: Sandbox, guestPath: string): Promise<Uint8Array | undefined> {
  try {
    return await sandbox.fs.readFile(guestPath);
  } catch {
    return undefined;
  }
}

function failedBuild(
  project: Project,
  stdout: string,
  stderr: string,
  code: number,
  source: "clang" | "wasm-ld",
  providedDiagnostics?: Diagnostic[],
): BuildResult {
  const diagnostics = providedDiagnostics ?? parseClangDiagnostics(`${stderr}\n${stdout}`);
  return {
    success: false,
    diagnostics: ensureFailureDiagnostic(diagnostics, {
      file: project.config.entry,
      source,
      message: stderr.trim() || `${source} exited with code ${code}.`,
    }),
    stdout,
    stderr,
    cacheHit: false,
  };
}
