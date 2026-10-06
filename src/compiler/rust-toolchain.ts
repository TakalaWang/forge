import type { Diagnostic, OptimizationLevel, ProjectFile } from "../core/types.ts";
import {
  RUST_COMPRESSED_PACKAGE_SHA256,
  RUST_PACKAGE_ASSET_PATH,
  RUST_PACKAGE_MANIFEST_ASSET_PATH,
  RUST_PACKAGE_MANIFEST_SHA256,
  RUST_PACKAGE_SHA256,
  RUST_VERSION,
} from "../core/toolchains.ts";
import {
  RUST_LINKER_COMMAND,
  RUST_OBJECT_PATH,
  decodeRustLinkerArgumentContract,
  type RustLinkerArgumentContract,
} from "./rust-linker.ts";
import type { RustDependencyCrate } from "./dependency-input.ts";

export const RUST_TARGET_TRIPLE = "wasm32-wasip1-threads";
export const RUST_EDITION = "2024";
export const RUST_COMPILE_TIMEOUT_MS = 180_000;
export const RUST_UNINIT_CONST_CHUNK_THRESHOLD = "4294967295";
export const RUST_DETERMINISTIC_REPLACEMENTS = Object.freeze([
  "wasi_snapshot_preview1.random_get",
  "wasi_snapshot_preview1.clock_time_get",
] as const);

export const RUST_TOOLCHAIN = Object.freeze({
  version: RUST_VERSION,
  packageAsset: RUST_PACKAGE_ASSET_PATH,
  packageCompressedSha256: RUST_COMPRESSED_PACKAGE_SHA256,
  packageSha256: RUST_PACKAGE_SHA256,
  manifestAsset: RUST_PACKAGE_MANIFEST_ASSET_PATH,
  manifestSha256: RUST_PACKAGE_MANIFEST_SHA256,
  target: RUST_TARGET_TRIPLE,
  edition: RUST_EDITION,
});

export interface RustCompileRequest {
  entry: string;
  files: readonly ProjectFile[];
  optimization: OptimizationLevel;
  dependencies?: readonly RustDependencyCrate[];
  rootExterns?: readonly { crateName: string; path: string }[];
}

export interface RustCompileResult {
  success: boolean;
  wasm?: Uint8Array;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}

export interface RustToolchainManifestContract {
  readonly linkerArguments: RustLinkerArgumentContract;
}

export function rustcObjectArguments(
  entry: string,
  optimization: OptimizationLevel,
  rootExterns: readonly { crateName: string; path: string }[] = [],
): string[] {
  const optimizationArguments = optimization === "release"
    ? ["-C", "opt-level=2", "-C", "debuginfo=0"]
    : ["-C", "opt-level=0", "-C", "debuginfo=1"];
  return [
    "--target", RUST_TARGET_TRIPLE,
    "--sysroot", "/rust",
    "-Zno-parallel-backend",
    "-Z", "threads=1",
    "-Z", "randomize-layout=no",
    "-Z", "layout-seed=0",
    "-Z", `uninit-const-chunk-threshold=${RUST_UNINIT_CONST_CHUNK_THRESHOLD}`,
    "-C", "codegen-units=1",
    "-C", "llvm-args=-rng-seed=1",
    "-C", "metadata=wasm_oj_submission",
    "-C", "target-feature=+atomics,+bulk-memory,+mutable-globals",
    `/workspace/${entry}`,
    "--crate-name", "wasm_oj_submission",
    "--crate-type", "bin",
    "--edition", RUST_EDITION,
    "--error-format=json",
    "--json=diagnostic-rendered-ansi",
    "--remap-path-prefix=/workspace=.",
    "-C", "panic=abort",
    ...rootExterns.flatMap((item) => ["--extern", `${item.crateName}=${item.path}`]),
    ...optimizationArguments,
    "-C", "save-temps=yes",
    "--emit=obj",
    "-o", RUST_OBJECT_PATH,
  ];
}

export function rustcDependencyArguments(
  dependency: RustDependencyCrate,
  optimization: OptimizationLevel,
): string[] {
  const optimizationArguments = optimization === "release"
    ? ["-C", "opt-level=2", "-C", "debuginfo=0"]
    : ["-C", "opt-level=0", "-C", "debuginfo=1"];
  return [
    "--target", RUST_TARGET_TRIPLE,
    "--sysroot", "/rust",
    "-Zno-parallel-backend",
    "-Z", "threads=1",
    "-Z", "randomize-layout=no",
    "-Z", "layout-seed=0",
    "-C", "codegen-units=1",
    "-C", "llvm-args=-rng-seed=1",
    "-C", `metadata=${dependency.id}`,
    "-C", "target-feature=+atomics,+bulk-memory,+mutable-globals",
    `/workspace/${dependency.root}`,
    "--crate-name", dependency.crateName,
    "--crate-type", "rlib",
    "--edition", dependency.edition,
    "--error-format=json",
    "--json=diagnostic-rendered-ansi",
    "--remap-path-prefix=/workspace=.",
    "-C", "panic=abort",
    "--cap-lints", "allow",
    ...dependency.features.flatMap((feature) => ["--cfg", `feature=${JSON.stringify(feature)}`]),
    ...dependency.externs.flatMap((item) => ["--extern", `${item.crateName}=${item.path}`]),
    ...optimizationArguments,
    "--emit=link",
    "-o", dependency.outputPath,
  ];
}

export function deterministicRustCompilerEnvironment(): Record<string, string> {
  return {
    RUST_MIN_STACK: "16777216",
    SOURCE_DATE_EPOCH: "946684800",
    TZ: "UTC",
    LC_ALL: "C",
  };
}

export function deterministicRustLinkerEnvironment(): Record<string, string> {
  return {
    SOURCE_DATE_EPOCH: "946684800",
    TZ: "UTC",
    LC_ALL: "C",
    VSLANG: "1033",
  };
}

export function decodeRustToolchainManifest(bytes: Uint8Array): RustToolchainManifestContract {
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
  const compiler = asRecord(manifest.compiler, "compiler");
  const linker = asRecord(manifest.linker, "linker");
  const pipeline = asRecord(manifest.pipeline, "pipeline");
  const output = asRecord(manifest.output, "output");
  const mounts = asRecord(manifest.filesystemMounts, "filesystemMounts");
  if (
    manifest.version !== RUST_TOOLCHAIN.version
    || manifest.target !== RUST_TOOLCHAIN.target
    || compiler.command !== "rustc"
    || JSON.stringify(compiler.deterministicReplacements) !== JSON.stringify(RUST_DETERMINISTIC_REPLACEMENTS)
    || linker.command !== RUST_LINKER_COMMAND
    || pipeline.strategy !== "rustc-object-then-wasm-ld"
    || pipeline.objectEmission !== "rustc --emit=obj -C save-temps=yes"
    || pipeline.allocatorShim !== "rustc-generated LLVM bitcode"
    || pipeline.linkArgsSource !== "rustc --print=link-args"
    || mounts.rust !== "/rust"
    || mounts.linker !== "/usr"
    || output.sha256 !== RUST_TOOLCHAIN.packageSha256
    || output.compressedSha256 !== RUST_TOOLCHAIN.packageCompressedSha256
  ) {
    throw new Error("Pinned Rust toolchain manifest does not match the compiler contract.");
  }
  return Object.freeze({
    linkerArguments: decodeRustLinkerArgumentContract(linker.arguments),
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Pinned Rust toolchain manifest '${label}' field must be an object.`);
  }
  return value as Record<string, unknown>;
}

export type RustcStageRequest =
  | {
    type: "compile";
    request: RustCompileRequest;
    assetBaseUrl: string;
  }
  | { type: "shutdown" };

export type RustcStageResponse =
  | { type: "result"; result: RustCompileResult }
  | { type: "shutdown-complete" }
  | { type: "error"; message: string; stack?: string };
