import { describe, expect, it } from "vitest";
import { WASM_OJ_SCHEMAS } from "../core/contract";
import { ClangObjectCache, parseClangDependencyFile } from "./clang-object-cache";
import type { ClangPins } from "./clang-pins";

const pins: ClangPins = {
  schema: WASM_OJ_SCHEMAS.clangPins,
  version: "test",
  source: "clang-test.webc",
  sourceSha256: "a".repeat(64),
  command: "clang",
  linkerCommand: "wasm-ld",
  placeholders: { input: "I", output: "O", mainFileName: "M", objects: "S" },
  configs: { "c-release": { cc1: ["-cc1"], link: [] } },
};
const encoder = new TextEncoder();

describe("ClangObjectCache", () => {
  it("reuses an object only while every project dependency digest matches", async () => {
    const cache = new ClangObjectCache(1024);
    const files = new Map([
      ["src/main.c", encoder.encode("#include \"value.h\"")],
      ["src/value.h", encoder.encode("#define VALUE 42")],
    ]);
    const key = await cache.unitManifestKey(pins, "c-release", "src/main.c", files.get("src/main.c")!);
    await expect(cache.store(
      key,
      ["src/main.c", "/workspace/src/value.h", "/sysroot/include/stdio.h"],
      files,
      new Uint8Array([1, 2, 3]),
    )).resolves.toBe(true);

    expect(await cache.lookup(key, files)).toEqual(new Uint8Array([1, 2, 3]));
    files.set("src/value.h", encoder.encode("#define VALUE 43"));
    expect(await cache.lookup(key, files)).toBeUndefined();
  });

  it("does not cache an object when the dependency closure is unusable", async () => {
    const cache = new ClangObjectCache(1024);
    const source = encoder.encode("int main(void){});");
    const files = new Map([["src/main.c", source]]);
    const key = await cache.unitManifestKey(pins, "c-release", "src/main.c", source);
    await expect(cache.store(key, ["/unknown/generated.h"], files, new Uint8Array([1])))
      .resolves.toBe(false);
    expect(await cache.lookup(key, files)).toBeUndefined();
  });

  it("invalidates unit identity for source, configuration argv, and toolchain changes", async () => {
    const cache = new ClangObjectCache(1024);
    const source = encoder.encode("int main(void){return 0;}");
    const base = await cache.unitManifestKey(pins, "c-release", "src/main.c", source);
    const changedSource = await cache.unitManifestKey(
      pins,
      "c-release",
      "src/main.c",
      encoder.encode("int main(void){return 1;}"),
    );
    const changedArgv = await cache.unitManifestKey({
      ...pins,
      configs: { "c-release": { cc1: ["-cc1", "-O2"], link: [] } },
    }, "c-release", "src/main.c", source);
    const changedToolchain = await cache.unitManifestKey({
      ...pins,
      sourceSha256: "b".repeat(64),
    }, "c-release", "src/main.c", source);
    const debugPins: ClangPins = {
      ...pins,
      configs: {
        ...pins.configs,
        "c-debug": { cc1: ["-cc1", "-O0"], link: [] },
      },
    };
    const changedConfig = await cache.unitManifestKey(debugPins, "c-debug", "src/main.c", source);

    expect(new Set([base, changedSource, changedArgv, changedToolchain, changedConfig])).toHaveLength(5);
  });
});

describe("parseClangDependencyFile", () => {
  it("parses continuations and escaped spaces", () => {
    const parsed = parseClangDependencyFile(encoder.encode("main.o: src/main.c \\\n src/value\\ header.h /sysroot/include/stdio.h\n"));
    expect(parsed).toEqual(["src/main.c", "src/value header.h", "/sysroot/include/stdio.h"]);
  });
});
