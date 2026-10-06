import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { Wasmer } from "@wasmer/sdk/node";
import {
  RUST_FINAL_OUTPUT_PATH,
  RUST_LINKER_COMMAND,
  RUST_OBJECT_PATH,
  instantiateRustLinkerArguments,
} from "../compiler/rust-linker.ts";
import {
  RUST_GUEST_ROOT,
  isRustArchive,
  runRustStage,
} from "../compiler/rust-sandbox.ts";
import {
  RUST_TOOLCHAIN,
  decodeRustToolchainManifest,
  deterministicRustCompilerEnvironment,
  deterministicRustLinkerEnvironment,
  rustcDependencyArguments,
  rustcObjectArguments,
} from "../compiler/rust-toolchain.ts";
let toolchain;

process.stdin.once("end", () => process.exit(0));

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line) continue;
  let response;
  try {
    response = { ok: true, result: await compile(JSON.parse(line)) };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(3, `${JSON.stringify(response)}\n`);
}

async function loadToolchain(encoded) {
  const packageAsset = requiredToolchainAsset(encoded, RUST_TOOLCHAIN.packageAsset);
  const manifestAsset = requiredToolchainAsset(encoded, RUST_TOOLCHAIN.manifestAsset);
  const identity = JSON.stringify([packageAsset, manifestAsset, encoded.verifiedToolchain === true]);
  if (toolchain?.identity === identity) return toolchain;
  const [packageBytes, manifest] = await Promise.all([
    loadRustPackage(packageAsset, encoded.verifiedToolchain === true),
    loadRustManifest(manifestAsset, encoded.verifiedToolchain === true),
  ]);
  const wasmer = new Wasmer({ cache: false });
  const pkg = await wasmer.packages.load(packageBytes);
  for (const command of ["rustc", RUST_LINKER_COMMAND]) {
    if (!pkg.commands.includes(command)) throw new Error(`The pinned Rust WebC does not expose its ${command} command.`);
  }
  toolchain = { identity, wasmer, pkg, manifest };
  return toolchain;
}

async function compile(encoded) {
  const { wasmer, pkg, manifest } = await loadToolchain(encoded);
  const sandbox = await wasmer.sandboxes.create({
    packages: [pkg],
    files: Object.fromEntries(encoded.request.files.map((file) => [`${RUST_GUEST_ROOT}/${file.path}`, file.content])),
  });
  const state = { abandoned: false };
  try {
    await sandbox.fs.mkdir(`${RUST_GUEST_ROOT}/build/deps`, { recursive: true });
    let dependencyStdout = "";
    let dependencyStderr = "";
    for (const dependency of encoded.request.dependencies ?? []) {
      const output = await runRustStage(sandbox, state, {
        command: "rustc",
        args: rustcDependencyArguments(dependency, encoded.request.optimization),
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
          diagnostics: parseRustDiagnostics(dependencyStderr, encoded.request.entry),
        };
      }
    }
    const compiled = await runRustStage(sandbox, state, {
      command: "rustc",
      args: rustcObjectArguments(
        encoded.request.entry,
        encoded.request.optimization,
        encoded.request.rootExterns,
      ),
      env: deterministicRustCompilerEnvironment(),
      outputPath: RUST_OBJECT_PATH,
      stage: "rustc",
      requiresAllocatorBitcode: true,
    });
    const diagnostics = parseRustDiagnostics(`${dependencyStderr}${compiled.stderr}`, encoded.request.entry);
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
      encoded.request.optimization,
      requireAllocatorBitcodePath(compiled),
    );
    const objectIndex = linkerArguments.indexOf(RUST_OBJECT_PATH);
    if (objectIndex < 0) throw new Error("Pinned Rust linker arguments omit the submission object.");
    const libraries = [...(encoded.request.dependencies ?? [])].reverse().map((item) => item.outputPath);
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
      wasmBase64: linked.bytes ? Buffer.from(linked.bytes).toString("base64") : undefined,
      stdout: `${dependencyStdout}${compiled.stdout}${linked.stdout}`,
      stderr: `${dependencyStderr}${compiled.stderr}${linked.stderr}`,
      diagnostics,
    };
  } finally {
    if (!state.abandoned) await sandbox.close();
  }
}

function requireAllocatorBitcodePath(observation) {
  if (!observation.allocatorBitcodePath) {
    throw new Error("rustc completed without its allocator bitcode module.");
  }
  return observation.allocatorBitcodePath;
}

async function loadRustPackage(file, verifiedToolchain) {
  const compressed = await readFile(file);
  if (!verifiedToolchain) verifyDigest(file, compressed, RUST_TOOLCHAIN.packageCompressedSha256);
  const bytes = uint8View(gunzipSync(compressed));
  if (!verifiedToolchain) verifyDigest("decompressed Rust WebC", bytes, RUST_TOOLCHAIN.packageSha256);
  return bytes;
}

async function loadRustManifest(file, verifiedToolchain) {
  const bytes = new Uint8Array(await readFile(file));
  if (!verifiedToolchain) verifyDigest(file, bytes, RUST_TOOLCHAIN.manifestSha256);
  return decodeRustToolchainManifest(bytes);
}

function requiredToolchainAsset(encoded, assetPath) {
  const file = encoded?.toolchainAssets?.[assetPath];
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error(`The Rust compiler stage did not receive absolute asset '${assetPath}'.`);
  }
  return file;
}

function verifyDigest(filename, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned Rust toolchain asset '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

function uint8View(bytes) {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseRustDiagnostics(output, entry) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.$message_type !== "diagnostic" || typeof value.message !== "string") continue;
    const spans = Array.isArray(value.spans) ? value.spans : [];
    const location = spans.find((span) => span?.is_primary) ?? spans[0];
    diagnostics.push({
      severity: value.level === "warning" ? "warning" : value.level === "note" ? "info" : "error",
      message: value.message,
      file: String(location?.file_name ?? entry).replace(/^\/workspace\//, ""),
      line: Number(location?.line_start ?? 1),
      column: Number(location?.column_start ?? 1),
      endLine: location?.line_end,
      endColumn: location?.column_end,
      source: "rustc",
      code: value.code?.code,
    });
  }
  return diagnostics;
}
