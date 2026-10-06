import { describe, expect, it } from "vitest";
import {
  RUST_FINAL_OUTPUT_PATH,
  RUST_ALLOCATOR_PLACEHOLDER,
  RUST_OBJECT_PATH,
  RUST_OBJECT_PLACEHOLDER,
  RUST_OUTPUT_PLACEHOLDER,
  decodeRustLinkerArgumentContract,
  instantiateRustLinkerArguments,
} from "./rust-linker";

const BASE = [
  "--shared-memory",
  "/rust/lib/rustlib/wasm32-wasip1-threads/lib/self-contained/crt1-command.o",
  RUST_OBJECT_PLACEHOLDER,
  RUST_ALLOCATOR_PLACEHOLDER,
  "/rust/lib/rustlib/wasm32-wasip1-threads/lib/libstd-example.rlib",
  "-o",
  RUST_OUTPUT_PLACEHOLDER,
  "--gc-sections",
];

function contract(overrides: Record<string, unknown> = {}) {
  return {
    objectPlaceholder: RUST_OBJECT_PLACEHOLDER,
    allocatorPlaceholder: RUST_ALLOCATOR_PLACEHOLDER,
    outputPlaceholder: RUST_OUTPUT_PLACEHOLDER,
    debug: [...BASE, "-O0"],
    release: [...BASE, "-O2"],
    ...overrides,
  };
}

describe("Rust linker argument contract", () => {
  it("validates and instantiates the pinned optimization-specific templates", () => {
    const decoded = decodeRustLinkerArgumentContract(contract());
    expect(instantiateRustLinkerArguments(decoded, "debug", "/workspace/build/main.allocator.rcgu.bc")).toEqual([
      "--shared-memory",
      "/rust/lib/rustlib/wasm32-wasip1-threads/lib/self-contained/crt1-command.o",
      RUST_OBJECT_PATH,
      "/workspace/build/main.allocator.rcgu.bc",
      "/rust/lib/rustlib/wasm32-wasip1-threads/lib/libstd-example.rlib",
      "-o",
      RUST_FINAL_OUTPUT_PATH,
      "--gc-sections",
      "-O0",
    ]);
    expect(instantiateRustLinkerArguments(decoded, "release", "/workspace/build/main.allocator.rcgu.bc")).toContain("-O2");
  });

  it.each([
    ["wrong object placeholder", { objectPlaceholder: "__OBJECT__" }],
    ["missing startup object", { debug: BASE.filter((item) => !item.endsWith("crt1-command.o")).concat("-O0") }],
    ["missing standard library", { release: BASE.filter((item) => !item.endsWith(".rlib")).concat("-O2") }],
    ["response file", { debug: [...BASE, "@/rust/link.rsp", "-O0"] }],
    ["host path", { release: [...BASE, "/tmp/host.o", "-O2"] }],
    ["duplicate object", { debug: [...BASE, RUST_OBJECT_PLACEHOLDER, "-O0"] }],
    ["duplicate allocator", { debug: [...BASE, RUST_ALLOCATOR_PLACEHOLDER, "-O0"] }],
    ["wrong output position", { release: [RUST_OUTPUT_PLACEHOLDER, ...BASE.filter((item) => item !== RUST_OUTPUT_PLACEHOLDER), "-O2"] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => decodeRustLinkerArgumentContract(contract(overrides))).toThrow();
  });

  it("rejects allocator bitcode outside the observed build output", () => {
    const decoded = decodeRustLinkerArgumentContract(contract());
    expect(() => instantiateRustLinkerArguments(decoded, "debug", "/tmp/allocator.bc"))
      .toThrow(/unexpected path/);
  });
});
