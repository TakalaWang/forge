import { describe, expect, it } from "vitest";
import {
  browserToolchainAssetPaths,
  CLANG_CC1_PINS_ASSET_PATH,
  CLANG_LIBCXX_PCH_DEBUG_ASSET_PATH,
  CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH,
  CLANG_LIBCXX_PCH_RELEASE_ASSET_PATH,
  CLANG_PACKAGE_ASSET_PATH,
  contentAddressedToolchainAssetUrl,
  expectedToolchainAssetSha256,
  PINNED_TOOLCHAIN_ASSET_SHA256,
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
  toolchainCacheIdentity,
  TOOLCHAINS,
} from "./toolchains";

describe("pinned toolchain assets", () => {
  it("uses one canonical WASM-OJ-named asset set with exact digests", () => {
    const entries = Object.entries(PINNED_TOOLCHAIN_ASSET_SHA256);
    expect(entries.length).toBeGreaterThan(0);
    for (const [assetPath, sha256] of entries) {
      expect(assetPath).toMatch(/^\/toolchains\/[a-z0-9.+-]+$/i);
      expect(assetPath).not.toMatch(/(?:core|split)-v\d+/i);
      expect(sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(expectedToolchainAssetSha256(assetPath)).toBe(sha256);
    }
  });

  it("fails closed for undeclared assets", () => {
    expect(() => expectedToolchainAssetSha256("retired-toolchain.wasm"))
      .toThrow("No pinned digest");
  });

  it("binds browser request and cache keys to exact asset content", () => {
    const base = new URL("https://cdn.example.invalid/wasm-oj-assets?tenant=judge");
    const resolved = contentAddressedToolchainAssetUrl(QUICKJS_ASSET_PATH, base);

    expect(resolved.href).toBe(
      `https://cdn.example.invalid/wasm-oj-assets/quickjs-0.15.1.wasm.gz.bin?tenant=judge&sha256=${QUICKJS_ASSET_SHA256}`,
    );
    expect(base.href).toBe("https://cdn.example.invalid/wasm-oj-assets?tenant=judge");
    expect(() => contentAddressedToolchainAssetUrl("/toolchains/unpinned.bin", base))
      .toThrow("No pinned digest");
  });

  it("keeps canonical definitions deeply immutable and returns cache-identity copies", () => {
    expect(Object.isFrozen(TOOLCHAINS)).toBe(true);
    expect(Object.isFrozen(TOOLCHAINS.rust)).toBe(true);
    expect(Object.isFrozen(TOOLCHAINS.rust.compilerPackages)).toBe(true);
    expect(Object.isFrozen(TOOLCHAINS.rust.targets)).toBe(true);

    const identity = toolchainCacheIdentity("rust");
    identity.compilerPackages.push("attacker-controlled@latest");
    identity.contentSha256.push("0".repeat(64));

    expect(TOOLCHAINS.rust.compilerPackages).not.toContain("attacker-controlled@latest");
    expect(toolchainCacheIdentity("rust").compilerPackages).not.toContain("attacker-controlled@latest");
    expect(toolchainCacheIdentity("rust").contentSha256).not.toContain("0".repeat(64));
  });
});

describe("browser toolchain asset selection", () => {
  it("lists the pinned assets one compile and run fetches per language", () => {
    expect(browserToolchainAssetPaths({ language: "c", optimization: "release" }))
      .toEqual([CLANG_PACKAGE_ASSET_PATH, CLANG_CC1_PINS_ASSET_PATH]);
    expect(browserToolchainAssetPaths({ language: "javascript", optimization: "release" }))
      .toEqual([QUICKJS_ASSET_PATH]);
    for (const language of ["c", "cpp", "rust", "go", "java", "python", "javascript", "typescript"]) {
      const paths = browserToolchainAssetPaths({ language, optimization: "release" });
      expect(Object.isFrozen(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(PINNED_TOOLCHAIN_ASSET_SHA256[path]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("adds only the libc++ PCH for the requested C++ optimization", () => {
    expect(browserToolchainAssetPaths({ language: "cpp", optimization: "release" }))
      .toEqual([CLANG_PACKAGE_ASSET_PATH, CLANG_CC1_PINS_ASSET_PATH]);
    expect(browserToolchainAssetPaths({ language: "cpp", optimization: "debug", libcxxPrecompiledHeader: true }))
      .toEqual([
        CLANG_PACKAGE_ASSET_PATH,
        CLANG_CC1_PINS_ASSET_PATH,
        CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH,
        CLANG_LIBCXX_PCH_DEBUG_ASSET_PATH,
      ]);
    expect(browserToolchainAssetPaths({ language: "cpp", optimization: "release", libcxxPrecompiledHeader: true }))
      .toContain(CLANG_LIBCXX_PCH_RELEASE_ASSET_PATH);
    expect(browserToolchainAssetPaths({ language: "c", optimization: "release", libcxxPrecompiledHeader: true }))
      .not.toContain(CLANG_LIBCXX_PCH_MANIFEST_ASSET_PATH);
  });

  it("fails closed for languages without a built-in toolchain", () => {
    expect(() => browserToolchainAssetPaths({ language: "kotlin", optimization: "release" }))
      .toThrow("no built-in toolchain for 'kotlin'");
  });
});
