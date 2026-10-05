import { afterEach, describe, expect, it, vi } from "vitest";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract";
import {
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
  TYPESCRIPT_ASSET_PATH,
  TYPESCRIPT_ASSET_SHA256,
} from "../core/toolchains";
import type { BrowserToolchainSource } from "../core/types";
import { prefetchBrowserToolchain } from "./toolchain-prefetch";

const QUICKJS_BYTES = 5;
const TYPESCRIPT_BYTES = 3;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser toolchain prefetch", () => {
  it("downloads every asset at its Worker URL and reports byte progress", async () => {
    const fetchMock = stubFetch((url) => new Response(new Uint8Array(bytesFor(url))));
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];
    const controller = new AbortController();

    await prefetchBrowserToolchain([source()], {
      language: "typescript",
      signal: controller.signal,
      onProgress: (update) => progress.push(update),
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `https://app.example.invalid/toolchains/quickjs-0.15.1.wasm.gz.bin?sha256=${QUICKJS_ASSET_SHA256}`,
      `https://app.example.invalid/toolchains/typescript-7.0.2.wasm.gz.bin?sha256=${TYPESCRIPT_ASSET_SHA256}`,
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init?.signal).toBe(controller.signal);
    expect(progress[0]).toEqual({ loadedBytes: 0, totalBytes: QUICKJS_BYTES + TYPESCRIPT_BYTES });
    expect(progress.at(-1)).toEqual({
      loadedBytes: QUICKJS_BYTES + TYPESCRIPT_BYTES,
      totalBytes: QUICKJS_BYTES + TYPESCRIPT_BYTES,
    });
  });

  it("rejects truncated and failed downloads", async () => {
    stubFetch(() => new Response(new Uint8Array(QUICKJS_BYTES - 1)));
    await expect(prefetchBrowserToolchain([source()], { language: "javascript" }))
      .rejects.toThrow(`'${QUICKJS_ASSET_PATH}' has 4 bytes; expected 5`);

    stubFetch(() => new Response("blocked", { status: 403 }));
    await expect(prefetchBrowserToolchain([source()], { language: "javascript" }))
      .rejects.toThrow(`Unable to prefetch pinned toolchain asset '${QUICKJS_ASSET_PATH}' (403)`);
  });

  it("fails closed for profiles the sources do not declare", async () => {
    const fetchMock = stubFetch(() => new Response(new Uint8Array(0)));
    await expect(prefetchBrowserToolchain([source()], { language: "python" }))
      .rejects.toThrow("No explicit toolchain source declares profile");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stubFetch(respond: (url: URL) => Response) {
  vi.stubGlobal("location", { href: "https://app.example.invalid/problems/1" });
  const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>(async (url) => respond(url));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bytesFor(url: URL): number {
  return url.pathname.endsWith("/quickjs-0.15.1.wasm.gz.bin") ? QUICKJS_BYTES : TYPESCRIPT_BYTES;
}

function source(): BrowserToolchainSource {
  return {
    kind: "browser",
    baseUrl: "/toolchains/",
    descriptor: {
      schema: WASM_OJ_SCHEMAS.toolchainPackage,
      id: "script",
      version: "1.0.0",
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      languages: ["javascript", "typescript"],
      profiles: [
        { language: "javascript", target: "wasip1", optimization: "release" },
        { language: "typescript", target: "wasip1", optimization: "release" },
      ],
      assets: [
        {
          path: QUICKJS_ASSET_PATH,
          bytes: QUICKJS_BYTES,
          sha256: QUICKJS_ASSET_SHA256,
          exportPath: "./assets/quickjs-0.15.1.wasm.gz.bin",
        },
        {
          path: TYPESCRIPT_ASSET_PATH,
          bytes: TYPESCRIPT_BYTES,
          sha256: TYPESCRIPT_ASSET_SHA256,
          exportPath: "./assets/typescript-7.0.2.wasm.gz.bin",
        },
      ],
    },
  };
}
