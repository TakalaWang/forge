import {
  browserToolchainAssetPaths,
  browserToolchainAssetUrl,
  snapshotBrowserToolchainSources,
  toolchainAssetSource,
  toolchainProfileSource,
} from "@wasm-oj/core";
import type {
  BrowserToolchainSource,
  Language,
  OptimizationLevel,
  TargetAbi,
} from "@wasm-oj/core";

export interface BrowserToolchainPrefetchProgress {
  readonly loadedBytes: number;
  readonly totalBytes: number;
}

export interface BrowserToolchainPrefetchOptions {
  readonly language: Language;
  readonly target?: TargetAbi;
  readonly optimization?: OptimizationLevel;
  /** C++ only: also fetch the admitted libc++ PCH used by projects that contain `wasm-oj.pch.hpp`. */
  readonly libcxxPrecompiledHeader?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BrowserToolchainPrefetchProgress) => void;
}

/**
 * Downloads the pinned toolchain assets for one language through the same
 * digest-addressed URLs the compiler and runner Workers request, so a later
 * build reads them from the HTTP cache (or the registered toolchain cache)
 * instead of spending its build boundary on the network. Byte counts are
 * checked here; Workers still verify digests before use.
 */
export async function prefetchBrowserToolchain(
  sources: readonly BrowserToolchainSource[],
  options: BrowserToolchainPrefetchOptions,
): Promise<void> {
  const snapshot = snapshotBrowserToolchainSources(sources);
  const optimization = options.optimization ?? "release";
  toolchainProfileSource(snapshot, options.language, options.target ?? "wasip1", optimization);
  const resolutionBaseUrl = globalThis.location?.href;
  if (!resolutionBaseUrl) throw new Error("Toolchain prefetch requires a browser location.");

  const assets = browserToolchainAssetPaths({
    language: options.language,
    optimization,
    libcxxPrecompiledHeader: options.libcxxPrecompiledHeader,
  }).map((path) => ({
    path,
    bytes: toolchainAssetSource(snapshot, path).asset.bytes,
    url: browserToolchainAssetUrl(snapshot, path, resolutionBaseUrl),
  }));
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let loadedBytes = 0;
  const report = () => options.onProgress?.({ loadedBytes, totalBytes });
  report();

  await Promise.all(assets.map(async (asset) => {
    const response = await fetch(asset.url, { signal: options.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Unable to prefetch pinned toolchain asset '${asset.path}' (${response.status}).`);
    }
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      loadedBytes += value.byteLength;
      report();
    }
    if (received !== asset.bytes) {
      throw new Error(`Prefetched toolchain asset '${asset.path}' has ${received} bytes; expected ${asset.bytes}.`);
    }
  }));
}
