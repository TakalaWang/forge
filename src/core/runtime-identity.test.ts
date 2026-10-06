import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";
import {
  runtimeIdentityBytes,
  WASM_OJ_RUNTIME_COMPONENTS,
  WASM_OJ_RUNTIME_IDENTITY_SHA256,
  verifyRuntimeIdentity,
} from "./runtime-identity";

describe("WASM-OJ runtime identity", () => {
  it("is reproducible from one exported canonical document", async () => {
    expect(new TextDecoder().decode(runtimeIdentityBytes())).toBe(
      `${JSON.stringify(WASM_OJ_RUNTIME_COMPONENTS)}\n`,
    );
    await expect(verifyRuntimeIdentity()).resolves.toBeUndefined();
    expect(await sha256Hex(runtimeIdentityBytes())).toBe(WASM_OJ_RUNTIME_IDENTITY_SHA256);
  });

  it("pins the executable browser runtime bytes", async () => {
    const runtimeCore = await readFile(fileURLToPath(new URL("../runner/generated/runtime-core_bg.wasm", import.meta.url)));
    const wasmerSdk = await readFile(fileURLToPath(new URL("../pkg/wasmer_sdk_js_bg.wasm", import.meta.resolve("@wasmer/sdk/browser"))));
    expect(await sha256Hex(runtimeCore)).toBe(WASM_OJ_RUNTIME_COMPONENTS.runtimeCoreWasmSha256);
    expect(await sha256Hex(wasmerSdk)).toBe(WASM_OJ_RUNTIME_COMPONENTS.wasmerSdkWasmSha256);
  });

  it("pins Cargo.lock, runtime-core source, and both vendored patches", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const files = [
      "crates/runtime-core/Cargo.lock",
      "crates/runtime-core/Cargo.toml",
      "vendor/shared-buffer/Cargo.toml",
      "vendor/virtual-fs/Cargo.toml",
    ];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`Runtime source root contains unsupported entry '${relative}'.`);
      }
    };
    await walk("crates/runtime-core/src");
    await walk("vendor/shared-buffer/src");
    await walk("vendor/virtual-fs/src");
    const table = await Promise.all(files.sort().map(async (relative) => {
      const contents = await readFile(path.join(root, relative));
      return { bytes: contents.byteLength, path: relative, sha256: await sha256Hex(contents) };
    }));
    expect(await sha256Hex(new TextEncoder().encode(`${JSON.stringify(table)}\n`)))
      .toBe(WASM_OJ_RUNTIME_COMPONENTS.runtimeSourceRootSha256);
  });
});
