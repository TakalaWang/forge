/// <reference lib="webworker" />

import { Directory, Runtime, Wasmer, init, type Command, type Instance } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import { instantiateRustLinkerArguments, RUST_FINAL_OUTPUT_PATH, RUST_LINKER_COMMAND, RUST_OBJECT_PATH } from "../compiler/rust-linker";
import { isLlvmBitcode, selectRustAllocatorBitcodeName } from "../compiler/rust-allocator-bitcode";
import {
  RUST_COMPILE_TIMEOUT_MS,
  RUST_TOOLCHAIN,
  decodeRustToolchainManifest,
  deterministicRustCompilerEnvironment,
  deterministicRustLinkerEnvironment,
  rustcDependencyArguments,
  rustcObjectArguments,
  type RustcStageRequest,
  type RustcStageResponse,
} from "../compiler/rust-toolchain";
import { parseRustDiagnostics } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { contentAddressedToolchainAssetUrl } from "../core/toolchains";
import { MountedOutputStabilityObserver } from "./mounted-output-stability";
import {
  createModuleWorkerBootstrap,
  type ModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
} from "./module-worker";
import { OwnedWorkerRegistry, type WorkerConstructorHost } from "./owned-worker-registry";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
const OUTPUT_QUIET_PERIOD_MS = 50;
const NESTED_WORKER_RELEASE_GRACE_MS = 1_000;
let requestTail = Promise.resolve();
let toolchain: Promise<RustStageToolchain> | undefined;
let toolchainBaseUrl: string | undefined;
const wasmerThreadWorkers = new OwnedWorkerRegistry(globalThis as unknown as WorkerConstructorHost);
let ownedWasmerWorkers: OwnedWorkerRegistry | undefined;
let wasmerThreadWorkerBootstrap: ModuleWorkerBootstrap | undefined;

scope.addEventListener("message", (event: MessageEvent<RustcStageRequest>) => {
  requestTail = requestTail.then(
    () => respond(event.data),
    () => respond(event.data),
  );
});

async function compile(message: RustcStageRequest) {
  if (message.type !== "compile") throw new Error("Invalid rustc stage request.");
  const baseUrl = new URL(message.assetBaseUrl, workerBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const { rustc, linker, manifest } = await loadToolchain(baseUrl);
  let work: Directory | undefined;

  try {
    work = new Directory(Object.fromEntries(
      message.request.files.map((file) => [`/${file.path}`, file.content]),
    ));
    await work.createDir("/build");
    await work.createDir("/build/deps");
    let dependencyStdout = "";
    let dependencyStderr = "";
    for (const dependency of message.request.dependencies ?? []) {
      const instance = await rustc.run({
        args: rustcDependencyArguments(dependency, message.request.optimization),
        env: deterministicRustCompilerEnvironment(),
        mount: { "/work": work },
        cwd: "/work",
      });
      const output = await observeMountedOutput(
        instance,
        work,
        dependency.outputPath,
        `rustc dependency ${dependency.id}`,
        (stderr) => parseRustDiagnostics(stderr).some((diagnostic) => diagnostic.severity === "error"),
        false,
        isRustArchive,
      );
      dependencyStdout += output.stdout;
      dependencyStderr += output.stderr;
      if (!output.success) {
        return {
          success: false,
          stdout: dependencyStdout,
          stderr: dependencyStderr,
          diagnostics: parseRustDiagnostics(dependencyStderr),
        };
      }
    }
    const rustcInstance = await rustc.run({
      args: rustcObjectArguments(
        message.request.entry,
        message.request.optimization,
        message.request.rootExterns,
      ),
      env: deterministicRustCompilerEnvironment(),
      mount: { "/work": work },
      cwd: "/work",
    });
    const compiled = await observeMountedOutput(
      rustcInstance,
      work,
      RUST_OBJECT_PATH,
      "rustc",
      (stderr) => parseRustDiagnostics(stderr).some((diagnostic) => diagnostic.severity === "error"),
      true,
    );
    const diagnostics = parseRustDiagnostics(`${dependencyStderr}${compiled.stderr}`);
    if (!compiled.success) {
      return {
        success: false,
        stdout: `${dependencyStdout}${compiled.stdout}`,
        stderr: `${dependencyStderr}${compiled.stderr}`,
        diagnostics,
      };
    }

    const linkerArguments = instantiateRustLinkerArguments(
        manifest.linkerArguments,
        message.request.optimization,
        requireAllocatorBitcodePath(compiled),
      );
    const objectIndex = linkerArguments.indexOf(RUST_OBJECT_PATH);
    if (objectIndex < 0) throw new Error("Pinned Rust linker arguments omit the submission object.");
    const libraries = [...(message.request.dependencies ?? [])].reverse().map((item) => item.outputPath);
    if (libraries.length > 0) linkerArguments.splice(objectIndex + 1, 0, ...libraries);
    const linkerInstance = await linker.run({
      args: linkerArguments,
      env: deterministicRustLinkerEnvironment(),
      mount: { "/work": work },
      cwd: "/work",
    });
    const linked = await observeMountedOutput(
      linkerInstance,
      work,
      RUST_FINAL_OUTPUT_PATH,
      "wasm-ld",
      (stderr) => /(?:wasm-ld|lld): error:/i.test(stderr),
    );
    return {
      success: linked.success && Boolean(linked.bytes),
      wasm: linked.bytes,
      stdout: `${dependencyStdout}${compiled.stdout}${linked.stdout}`,
      stderr: `${dependencyStderr}${compiled.stderr}${linked.stderr}`,
      diagnostics,
    };
  } finally {
    work?.free();
  }
}

interface RustStageToolchain {
  runtime: Runtime;
  pkg: Wasmer;
  rustc: Command;
  linker: Command;
  manifest: Awaited<ReturnType<typeof loadRustManifest>>;
}

async function respond(message: RustcStageRequest): Promise<void> {
  try {
    if (message.type === "shutdown") {
      await shutdownToolchain();
      scope.postMessage({ type: "shutdown-complete" } satisfies RustcStageResponse);
      scope.close();
      return;
    }
    const result = await wasmerThreadWorkers.run(() => compile(message));
    const response: RustcStageResponse = { type: "result", result };
    const transfer = result.wasm ? [result.wasm.buffer] : [];
    scope.postMessage(response, transfer);
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ type: "error", message: caught.message, stack: caught.stack } satisfies RustcStageResponse);
  }
}

async function shutdownToolchain(): Promise<void> {
  const pending = toolchain;
  toolchain = undefined;
  toolchainBaseUrl = undefined;
  if (!pending) {
    terminateOwnedWasmerWorkers();
    disposeWasmerThreadWorkerBootstrap();
    return;
  }
  let loaded: RustStageToolchain;
  try {
    loaded = await pending;
  } catch (error) {
    terminateOwnedWasmerWorkers();
    disposeWasmerThreadWorkerBootstrap();
    throw error;
  }
  // Browser termination of a parent Worker does not run Rust Drop for SDK
  // WorkerHandle values. End nested workers first, while their shared Wasmer
  // memory is still valid. Chromium releases the backing thread resources
  // asynchronously, so keep the owning SDK memory alive across the bounded
  // release window before starting another generation.
  terminateOwnedWasmerWorkers();
  await new Promise<void>((resolve) => setTimeout(resolve, NESTED_WORKER_RELEASE_GRACE_MS));
  try {
    loaded.rustc.free();
  } finally {
    try {
      loaded.linker.free();
    } finally {
      try {
        loaded.pkg.free();
      } finally {
        loaded.runtime.free();
        disposeWasmerThreadWorkerBootstrap();
      }
    }
  }
}

function loadToolchain(baseUrl: URL): Promise<RustStageToolchain> {
  const identity = baseUrl.href;
  if (toolchainBaseUrl !== undefined && toolchainBaseUrl !== identity) {
    throw new Error("The persistent rustc stage cannot change its toolchain asset base URL.");
  }
  toolchainBaseUrl = identity;
  toolchain ??= initializeToolchain(baseUrl);
  return toolchain;
}

async function initializeToolchain(baseUrl: URL): Promise<RustStageToolchain> {
  wasmerThreadWorkers.install();
  ownedWasmerWorkers = wasmerThreadWorkers;
  const bootstrap = createModuleWorkerBootstrap(new URL(wasmerThreadWorkerUrl, workerBaseUrl));
  wasmerThreadWorkerBootstrap = bootstrap;
  try {
    await init({
      log: "warn",
      module: new URL(wasmerWasmUrl, workerBaseUrl),
      workerUrl: bootstrap.url,
    });
  } catch (error) {
    terminateOwnedWasmerWorkers();
    disposeWasmerThreadWorkerBootstrap();
    throw error;
  }
  let runtime: Runtime;
  try {
    runtime = new Runtime({ registry: null });
  } catch (error) {
    terminateOwnedWasmerWorkers();
    disposeWasmerThreadWorkerBootstrap();
    throw error;
  }
  let pkg: Wasmer | undefined;
  let rustc: Command | undefined;
  let linker: Command | undefined;
  try {
    const [packageBytes, manifest] = await Promise.all([
      loadRustPackage(baseUrl),
      loadRustManifest(baseUrl),
    ]);
    pkg = await Wasmer.fromFile(packageBytes, runtime);
    rustc = pkg.commands.rustc;
    if (!rustc) throw new Error("The pinned Rust WebC does not expose its rustc command.");
    linker = pkg.commands[RUST_LINKER_COMMAND];
    if (!linker) throw new Error(`The pinned Rust WebC does not expose its ${RUST_LINKER_COMMAND} command.`);
    return { runtime, pkg, rustc, linker, manifest };
  } catch (error) {
    rustc?.free();
    linker?.free();
    pkg?.free();
    runtime.free();
    terminateOwnedWasmerWorkers();
    disposeWasmerThreadWorkerBootstrap();
    throw error;
  }
}

function terminateOwnedWasmerWorkers(): void {
  const registry = ownedWasmerWorkers;
  ownedWasmerWorkers = undefined;
  registry?.terminateAll();
}

function disposeWasmerThreadWorkerBootstrap(): void {
  wasmerThreadWorkerBootstrap?.revoke();
  wasmerThreadWorkerBootstrap = undefined;
}

interface StageObservation {
  success: boolean;
  bytes?: Uint8Array;
  allocatorBitcodePath?: string;
  stdout: string;
  stderr: string;
}

async function observeMountedOutput(
  instance: Instance,
  work: Directory,
  guestPath: string,
  stage: string,
  hasTerminalError: (stderr: string) => boolean,
  requiresAllocatorBitcode = false,
  outputValidator: (bytes: Uint8Array) => boolean = (bytes) => WebAssembly.validate(Uint8Array.from(bytes)),
): Promise<StageObservation> {
  const stdout = captureReadable(instance.stdout);
  const stderr = captureReadable(instance.stderr);
  const outputStability = new MountedOutputStabilityObserver();
  let allocatorStability = new MountedOutputStabilityObserver();
  let allocatorCandidatePath: string | undefined;
  const deadline = performance.now() + RUST_COMPILE_TIMEOUT_MS;
  try {
    while (performance.now() < deadline) {
      const stderrText = stderr.text();
      const quiet = stdout.quietFor(OUTPUT_QUIET_PERIOD_MS) && stderr.quietFor(OUTPUT_QUIET_PERIOD_MS);
      const observedAt = performance.now();
      const bytes = outputStability.observe(await readValidOutput(work, guestPath, outputValidator), observedAt);
      const allocator = requiresAllocatorBitcode ? await readRustAllocatorBitcode(work) : undefined;
      if (allocator?.path !== allocatorCandidatePath) {
        allocatorCandidatePath = allocator?.path;
        allocatorStability = new MountedOutputStabilityObserver();
      }
      const allocatorBytes = requiresAllocatorBitcode
        ? allocatorStability.observe(allocator?.bytes, observedAt)
        : undefined;
      const allocatorReady = !requiresAllocatorBitcode || Boolean(allocatorBytes && allocatorCandidatePath);
      if (bytes && allocatorReady && quiet) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return {
          success: true,
          bytes,
          allocatorBitcodePath: allocatorCandidatePath,
          stdout: stdout.text(),
          stderr: stderr.text(),
        };
      }
      if (quiet && hasTerminalError(stderrText)) {
        return { success: false, stdout: stdout.text(), stderr: stderrText };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${stage} exceeded ${RUST_COMPILE_TIMEOUT_MS} ms.`);
  } finally {
    await Promise.all([stdout.cancel(), stderr.cancel()]);
    instance.free();
  }
}

function requireAllocatorBitcodePath(observation: StageObservation): string {
  if (!observation.allocatorBitcodePath) {
    throw new Error("rustc completed without its allocator bitcode module.");
  }
  return observation.allocatorBitcodePath;
}

function captureReadable(stream: ReadableStream): {
  text(): string;
  quietFor(milliseconds: number): boolean;
  cancel(): Promise<void>;
} {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let updatedAt = performance.now();
  void (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        const bytes = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value as ArrayBuffer);
        chunks.push(bytes.slice());
        updatedAt = performance.now();
      }
    } catch {
      // Cancellation is expected once the complete mounted output is observed.
    }
  })();
  return {
    text: () => new TextDecoder().decode(concatenate(chunks)),
    quietFor: (milliseconds) => performance.now() - updatedAt >= milliseconds,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The guest may close the stream concurrently with mounted-output observation.
      }
    },
  };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readValidOutput(
  work: Directory,
  guestPath: string,
  validator: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array | undefined> {
  const mountRelativePath = guestPath.startsWith("/work/") ? guestPath.slice("/work".length) : guestPath;
  try {
    const bytes = (await work.readFile(mountRelativePath)).slice();
    return bytes.byteLength > 8 && validator(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function isRustArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8 && new TextDecoder().decode(bytes.subarray(0, 8)) === "!<arch>\n";
}

async function readRustAllocatorBitcode(
  work: Directory,
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  try {
    const name = selectRustAllocatorBitcodeName((await work.readDir("/build")).map((entry) => entry.name));
    if (!name) return undefined;
    const bytes = (await work.readFile(`/build/${name}`)).slice();
    return isLlvmBitcode(bytes) ? { path: `/work/build/${name}`, bytes } : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("rustc emitted multiple")) throw error;
    return undefined;
  }
}

async function loadRustPackage(baseUrl: URL): Promise<Uint8Array> {
  const compressed = await loadVerifiedAssetResponse(
    baseUrl,
    RUST_TOOLCHAIN.packageAsset,
    RUST_TOOLCHAIN.packageCompressedSha256,
  );
  const body = compressed.body;
  if (!body) throw new Error("Pinned Rust WebC response has no body.");
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  await verifyDigest("decompressed Rust WebC", bytes, RUST_TOOLCHAIN.packageSha256);
  return bytes;
}

async function loadVerifiedAssetResponse(baseUrl: URL, assetPath: string, expectedSha256: string): Promise<Response> {
  const filename = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) {
    throw new Error(`Unable to load pinned Rust toolchain asset '${filename}' (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  await verifyDigest(filename, bytes, expectedSha256);
  return response;
}

async function loadRustManifest(baseUrl: URL) {
  const bytes = await loadVerifiedAsset(
    baseUrl,
    RUST_TOOLCHAIN.manifestAsset,
    RUST_TOOLCHAIN.manifestSha256,
  );
  return decodeRustToolchainManifest(bytes);
}

async function loadVerifiedAsset(baseUrl: URL, assetPath: string, expectedSha256: string): Promise<Uint8Array> {
  const filename = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) {
    throw new Error(`Unable to load pinned Rust toolchain asset '${filename}' (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyDigest(filename, bytes, expectedSha256);
  return bytes;
}

async function verifyDigest(label: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`Pinned Rust toolchain asset '${label}' has digest ${actual}; expected ${expected}.`);
  }
}
