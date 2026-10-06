import { sha256Hex } from "../core/hash.ts";
import { WASM_OJ_SCHEMAS } from "../core/contract.ts";
import {
  CLANG_CC1_PINS_SHA256,
  CLANG_PACKAGE_SHA256,
} from "../core/toolchains.ts";
import type { ClangPins } from "./clang-pins.ts";
import {
  IncrementalBuildGraph,
  type IncrementalBuildGraphState,
  type BuildGraphInput,
  type IncrementalBuildGraphSnapshot,
} from "./incremental-build-graph.ts";

const decoder = new TextDecoder();

/**
 * Content-addressed direct-mode cache for Clang translation units.
 *
 * Unit identity includes the frozen argv manifest and source digest. Every
 * project dependency from Clang's dependency file is rehashed before reuse.
 * System headers are covered by the pinned toolchain identity.
 */
export class ClangObjectCache {
  private readonly graph: IncrementalBuildGraph;

  constructor(limitBytes: number) {
    this.graph = new IncrementalBuildGraph(limitBytes);
  }

  async unitManifestKey(
    pins: ClangPins,
    configKey: string,
    source: string,
    sourceBytes: Uint8Array,
  ): Promise<string> {
    const config = pins.configs[configKey];
    if (!config) throw new Error(`Unknown pinned Clang configuration '${configKey}'.`);
    return sha256Hex(JSON.stringify({
      schema: WASM_OJ_SCHEMAS.objectCache,
      pinsSha256: CLANG_CC1_PINS_SHA256,
      sourceToolchainSha256: pins.sourceSha256,
      packageSha256: CLANG_PACKAGE_SHA256,
      version: pins.version,
      config: configKey,
      cc1Argv: config.cc1,
      unit: source,
      source: await sha256Hex(sourceBytes),
    }));
  }

  async lookup(
    manifestKey: string,
    projectFiles: ReadonlyMap<string, Uint8Array>,
    additionalInputs: readonly BuildGraphInput[] = [],
  ): Promise<Uint8Array | undefined> {
    return this.graph.lookup(manifestKey, availableInputs(projectFiles, additionalInputs));
  }

  async store(
    manifestKey: string,
    dependencyPaths: readonly string[],
    projectFiles: ReadonlyMap<string, Uint8Array>,
    object: Uint8Array,
    additionalInputs: readonly BuildGraphInput[] = [],
  ): Promise<boolean> {
    const normalized = normalizeProjectDependencies(dependencyPaths, projectFiles);
    if (!normalized) return false;
    return this.graph.store("object", manifestKey, [...graphInputs(normalized, projectFiles), ...additionalInputs], object);
  }

  async lookupPch(manifestKey: string, projectFiles: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array | undefined> {
    return this.graph.lookup(manifestKey, availableInputs(projectFiles));
  }

  async storePch(
    manifestKey: string,
    dependencyPaths: readonly string[],
    projectFiles: ReadonlyMap<string, Uint8Array>,
    pch: Uint8Array,
  ): Promise<boolean> {
    const normalized = normalizeProjectDependencies(dependencyPaths, projectFiles);
    if (!normalized) return false;
    return this.graph.store("pch", manifestKey, graphInputs(normalized, projectFiles), pch);
  }

  lookupLink(manifestKey: string, objects: readonly BuildGraphInput[]): Promise<Uint8Array | undefined> {
    return this.graph.lookupExact("link-result", manifestKey, withToolchain(objects));
  }

  storeLink(manifestKey: string, objects: readonly BuildGraphInput[], wasm: Uint8Array): Promise<boolean> {
    return this.graph.store("link-result", manifestKey, withToolchain(objects), wasm);
  }

  snapshot(): IncrementalBuildGraphSnapshot {
    return this.graph.snapshot();
  }

  exportState(): IncrementalBuildGraphState {
    return this.graph.exportState();
  }

  restoreState(state: IncrementalBuildGraphState): Promise<void> {
    return this.graph.restoreState(state);
  }

  clear(): void {
    this.graph.clear();
  }
}

export function parseClangDependencyFile(bytes: Uint8Array): string[] {
  const joined = decoder.decode(bytes).replace(/\\\r?\n/g, " ");
  const colon = joined.indexOf(":");
  if (colon < 0) return [];
  const deps: string[] = [];
  const pattern = /(?:\\.|[^\s\\])+/g;
  const remainder = joined.slice(colon + 1);
  for (let match = pattern.exec(remainder); match; match = pattern.exec(remainder)) {
    deps.push(match[0].replace(/\\(.)/g, "$1"));
  }
  return deps;
}

function normalizeProjectDependencies(
  dependencyPaths: readonly string[],
  projectFiles: ReadonlyMap<string, Uint8Array>,
): string[] | undefined {
  const normalized = new Set<string>();
  for (const raw of dependencyPaths) {
    if (raw.startsWith("/usr/") || raw.startsWith("/sysroot/") || raw.startsWith("/lib/")) continue;
    const path = raw.replace(/^(?:\/workspace\/|\/project\/|\.\/)/, "");
    if (!path || path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      return undefined;
    }
    if (!projectFiles.has(path)) return undefined;
    normalized.add(path);
  }
  if (normalized.size === 0) return undefined;
  return [...normalized].sort();
}

function fileKind(path: string): "source" | "header" {
  return /\.(?:c|cc|cpp|cxx)$/i.test(path) ? "source" : "header";
}

function graphInputs(paths: readonly string[], projectFiles: ReadonlyMap<string, Uint8Array>): BuildGraphInput[] {
  return withToolchain(paths.map((path) => ({
    kind: fileKind(path),
    identity: path,
    bytes: projectFiles.get(path)!,
  })));
}

function withToolchain(inputs: readonly BuildGraphInput[]): BuildGraphInput[] {
  return [...inputs, {
    kind: "package",
    identity: `cpp:clang@${CLANG_PACKAGE_SHA256}`,
    digest: CLANG_PACKAGE_SHA256,
  }];
}

function availableInputs(
  projectFiles: ReadonlyMap<string, Uint8Array>,
  additionalInputs: readonly BuildGraphInput[] = [],
): ReadonlyMap<string, BuildGraphInput> {
  const inputs = new Map<string, BuildGraphInput>(
    [...projectFiles].map(([path, bytes]) => [path, { kind: fileKind(path), identity: path, bytes }]),
  );
  inputs.set(`cpp:clang@${CLANG_PACKAGE_SHA256}`, {
      kind: "package" as const,
      identity: `cpp:clang@${CLANG_PACKAGE_SHA256}`,
      digest: CLANG_PACKAGE_SHA256,
  });
  for (const input of additionalInputs) inputs.set(input.identity, input);
  return inputs;
}
