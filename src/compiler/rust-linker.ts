import type { OptimizationLevel } from "../core/types.ts";

export const RUST_LINKER_COMMAND = "wasm-ld";
export const RUST_OBJECT_PATH = "/workspace/build/main.o";
export const RUST_FINAL_OUTPUT_PATH = "/workspace/build/main.wasm";
export const RUST_OBJECT_PLACEHOLDER = "__WASM_OJ_RUST_OBJECT__";
export const RUST_ALLOCATOR_PLACEHOLDER = "__WASM_OJ_RUST_ALLOCATOR_BITCODE__";
export const RUST_OUTPUT_PLACEHOLDER = "__WASM_OJ_RUST_OUTPUT__";

export interface RustLinkerArgumentContract {
  readonly objectPlaceholder: typeof RUST_OBJECT_PLACEHOLDER;
  readonly allocatorPlaceholder: typeof RUST_ALLOCATOR_PLACEHOLDER;
  readonly outputPlaceholder: typeof RUST_OUTPUT_PLACEHOLDER;
  readonly debug: readonly string[];
  readonly release: readonly string[];
}

/** Validate the exact linker argv embedded in the digest-pinned Rust manifest. */
export function decodeRustLinkerArgumentContract(value: unknown): RustLinkerArgumentContract {
  if (!isRecord(value)) throw new Error("Pinned Rust linker arguments must be an object.");
  if (value.objectPlaceholder !== RUST_OBJECT_PLACEHOLDER) {
    throw new Error("Pinned Rust linker object placeholder does not match the compiler contract.");
  }
  if (value.outputPlaceholder !== RUST_OUTPUT_PLACEHOLDER) {
    throw new Error("Pinned Rust linker output placeholder does not match the compiler contract.");
  }
  if (value.allocatorPlaceholder !== RUST_ALLOCATOR_PLACEHOLDER) {
    throw new Error("Pinned Rust linker allocator placeholder does not match the compiler contract.");
  }
  const debug = validateTemplate("debug", value.debug, "-O0");
  const release = validateTemplate("release", value.release, "-O2");
  return Object.freeze({
    objectPlaceholder: RUST_OBJECT_PLACEHOLDER,
    allocatorPlaceholder: RUST_ALLOCATOR_PLACEHOLDER,
    outputPlaceholder: RUST_OUTPUT_PLACEHOLDER,
    debug,
    release,
  });
}

export function instantiateRustLinkerArguments(
  contract: RustLinkerArgumentContract,
  optimization: OptimizationLevel,
  allocatorBitcodePath: string,
): string[] {
  if (!/^\/workspace\/build\/main\.[a-z0-9]+\.rcgu\.bc$/i.test(allocatorBitcodePath)) {
    throw new Error(`Rust allocator bitcode has unexpected path '${allocatorBitcodePath}'.`);
  }
  const template = optimization === "release" ? contract.release : contract.debug;
  return template.map((argument) => {
    if (argument === contract.objectPlaceholder) return RUST_OBJECT_PATH;
    if (argument === contract.allocatorPlaceholder) return allocatorBitcodePath;
    if (argument === contract.outputPlaceholder) return RUST_FINAL_OUTPUT_PATH;
    return argument;
  });
}

function validateTemplate(label: string, value: unknown, expectedOptimization: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Pinned Rust ${label} linker arguments must be a non-empty string array.`);
  }
  const args = value as string[];
  requireExactlyOnce(args, RUST_OBJECT_PLACEHOLDER, `${label} object placeholder`);
  requireExactlyOnce(args, RUST_ALLOCATOR_PLACEHOLDER, `${label} allocator placeholder`);
  const outputIndex = requireExactlyOnce(args, RUST_OUTPUT_PLACEHOLDER, `${label} output placeholder`);
  if (outputIndex === 0 || args[outputIndex - 1] !== "-o") {
    throw new Error(`Pinned Rust ${label} linker output placeholder must follow '-o'.`);
  }
  requireExactlyOnce(args, expectedOptimization, `${label} linker optimization`);
  if (!args.includes("--gc-sections") || !args.includes("--shared-memory")) {
    throw new Error(`Pinned Rust ${label} linker arguments omit required WebAssembly flags.`);
  }
  if (!args.some((argument) => argument.endsWith("/self-contained/crt1-command.o"))) {
    throw new Error(`Pinned Rust ${label} linker arguments omit the WASI command startup object.`);
  }
  if (!args.some((argument) => argument.startsWith("/rust/") && argument.endsWith(".rlib"))) {
    throw new Error(`Pinned Rust ${label} linker arguments omit the Rust standard library.`);
  }
  for (const argument of args) {
    if (!argument || argument.includes("\0")) {
      throw new Error(`Pinned Rust ${label} linker arguments contain an empty or NUL-bearing value.`);
    }
    if (argument.startsWith("@")) {
      throw new Error(`Pinned Rust ${label} linker arguments unexpectedly use a response file.`);
    }
    if (argument.startsWith("/") && (!argument.startsWith("/rust/") || argument.split("/").includes(".."))) {
      throw new Error(`Pinned Rust ${label} linker arguments reference unmounted path '${argument}'.`);
    }
  }
  return Object.freeze([...args]);
}

function requireExactlyOnce(args: readonly string[], value: string, label: string): number {
  const indices = args.flatMap((argument, index) => argument === value ? [index] : []);
  if (indices.length !== 1) throw new Error(`Pinned Rust ${label} must occur exactly once.`);
  return indices[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
