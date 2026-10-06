/// <reference lib="webworker" />

import type { Package, Wasmer } from "@wasmer/sdk";
import { instantiateRustLinkerArguments, RUST_FINAL_OUTPUT_PATH, RUST_LINKER_COMMAND, RUST_OBJECT_PATH } from "../compiler/rust-linker";
import {
  RUST_GUEST_ROOT,
  isRustArchive,
  runRustStage,
  type RustStageObservation,
} from "../compiler/rust-sandbox";
import {
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
import { moduleWorkerBaseUrl } from "./module-worker";
import { OwnedWorkerRegistry, type WorkerConstructorHost } from "./owned-worker-registry";
import { createBrowserWasmer } from "./wasmer-sdk";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
const NESTED_WORKER_RELEASE_GRACE_MS = 1_000;
let requestTail = Promise.resolve();
let toolchain: Promise<RustStageToolchain> | undefined;
let toolchainBaseUrl: string | undefined;
let ownedWasmerWorkers: OwnedWorkerRegistry | undefined;

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
  const { wasmer, pkg, manifest } = await loadToolchain(baseUrl);
  const sandbox = await wasmer.sandboxes.create({
    packages: [pkg],
    files: Object.fromEntries(message.request.files.map((file) => [`${RUST_GUEST_ROOT}/${file.path}`, file.content])),
  });
  const state = { abandoned: false };

  try {
    await sandbox.fs.mkdir(`${RUST_GUEST_ROOT}/build/deps`, { recursive: true });
    let dependencyStdout = "";
    let dependencyStderr = "";
    for (const dependency of message.request.dependencies ?? []) {
      const output = await runRustStage(sandbox, state, {
        command: "rustc",
        args: rustcDependencyArguments(dependency, message.request.optimization),
        env: deterministicRustCompilerEnvironment(),
        outputPath: dependency.outputPath,
        stage: `rustc dependency ${dependency.id}`,
        outputValidator: isRustArchive,
      });
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
    const compiled = await runRustStage(sandbox, state, {
      command: "rustc",
      args: rustcObjectArguments(
        message.request.entry,
        message.request.optimization,
        message.request.rootExterns,
      ),
      env: deterministicRustCompilerEnvironment(),
      outputPath: RUST_OBJECT_PATH,
      stage: "rustc",
      requiresAllocatorBitcode: true,
    });
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
    const linked = await runRustStage(sandbox, state, {
      command: RUST_LINKER_COMMAND,
      args: linkerArguments,
      env: deterministicRustLinkerEnvironment(),
      outputPath: RUST_FINAL_OUTPUT_PATH,
      stage: "wasm-ld",
    });
    return {
      success: linked.success && Boolean(linked.bytes),
      wasm: linked.bytes,
      stdout: `${dependencyStdout}${compiled.stdout}${linked.stdout}`,
      stderr: `${dependencyStderr}${compiled.stderr}${linked.stderr}`,
      diagnostics,
    };
  } finally {
    if (!state.abandoned) await sandbox.close();
  }
}

interface RustStageToolchain {
  wasmer: Wasmer;
  pkg: Package;
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
    const result = await compile(message);
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
    return;
  }
  try {
    await pending;
  } finally {
    // Browser termination of a parent Worker does not run Rust Drop for SDK
    // WorkerHandle values, and the SDK's own shutdown would terminate them at
    // arbitrary points. End nested workers first, then keep the owning SDK
    // memory alive across Chromium's asynchronous thread release before
    // another generation starts.
    terminateOwnedWasmerWorkers();
    await new Promise<void>((resolve) => setTimeout(resolve, NESTED_WORKER_RELEASE_GRACE_MS));
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
  const workerRegistry = new OwnedWorkerRegistry(globalThis as unknown as WorkerConstructorHost);
  workerRegistry.install();
  ownedWasmerWorkers = workerRegistry;
  try {
    const [wasmer, packageBytes, manifest] = await Promise.all([
      createBrowserWasmer(),
      loadRustPackage(baseUrl),
      loadRustManifest(baseUrl),
    ]);
    const pkg = await wasmer.packages.load(packageBytes);
    for (const command of ["rustc", RUST_LINKER_COMMAND]) {
      if (!pkg.commands.includes(command)) throw new Error(`The pinned Rust WebC does not expose its ${command} command.`);
    }
    return { wasmer, pkg, manifest };
  } catch (error) {
    terminateOwnedWasmerWorkers();
    throw error;
  }
}

function terminateOwnedWasmerWorkers(): void {
  const registry = ownedWasmerWorkers;
  ownedWasmerWorkers = undefined;
  registry?.terminateAll();
}

function requireAllocatorBitcodePath(observation: RustStageObservation): string {
  if (!observation.allocatorBitcodePath) {
    throw new Error("rustc completed without its allocator bitcode module.");
  }
  return observation.allocatorBitcodePath;
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
