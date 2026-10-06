import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WASM_OJ_CONTRACT_ID } from "../src/core/contract.ts";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "../src/core/toolchains.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRoot = path.join(root, "public");
const publicToolchainRoot = path.join(publicRoot, "toolchains");
const distRoot = path.join(root, "dist");
const clientRoot = path.join(distRoot, "client");
const providerFileLimit = 25 * 1024 * 1024;
const providerWorkerLimit = 10 * 1024 * 1024;
const chunkByteLength = 16 * 1024 * 1024;
const manifestName = "wasm-oj-sites-chunks.json";
const generatedNames: string[] = [];

interface ChunkRecord {
  path: string;
  byteLength: number;
  sha256: string;
}

interface ChunkedAssetRecord {
  path: string;
  byteLength: number;
  sha256: string;
  chunks: ChunkRecord[];
}

try {
  const assets = await stageChunkTransport();
  await runVinextBuild();
  await finalizeSitesOutput(assets);
} finally {
  await cleanupStaging();
}

async function stageChunkTransport(): Promise<ChunkedAssetRecord[]> {
  await cleanupStaging();
  const assets: ChunkedAssetRecord[] = [];
  for (const [assetPath, expectedSha256] of Object.entries(PINNED_TOOLCHAIN_ASSET_SHA256).sort(compareEntries)) {
    const sourcePath = path.join(publicRoot, assetPath.slice(1));
    const bytes = new Uint8Array(await readFile(sourcePath));
    if (bytes.byteLength <= providerFileLimit) continue;
    requireDigest(assetPath, bytes, expectedSha256);
    const chunks: ChunkRecord[] = [];
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkByteLength, index += 1) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkByteLength, bytes.byteLength));
      const name = `${path.basename(assetPath)}.wasm-oj-chunk-${String(index).padStart(3, "0")}`;
      const chunkPath = `/toolchains/${name}`;
      await writeFile(path.join(publicToolchainRoot, name), chunk, { flag: "wx", mode: 0o644 });
      generatedNames.push(name);
      chunks.push({ path: chunkPath, byteLength: chunk.byteLength, sha256: sha256(chunk) });
    }
    assets.push({ path: assetPath, byteLength: bytes.byteLength, sha256: expectedSha256, chunks });
  }
  if (assets.length === 0) throw new Error("Sites toolchain preparation found no provider-limit assets to chunk.");
  await writeFile(path.join(publicToolchainRoot, manifestName), `${JSON.stringify({
    schema: `${WASM_OJ_CONTRACT_ID}/sites-toolchain-chunks`,
    assets,
  }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  generatedNames.push(manifestName);
  return assets;
}

async function runVinextBuild(): Promise<void> {
  const executable = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");
  const child = spawn(executable, ["build"], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: path.join(root, ".wrangler/wrangler.log") },
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => {
      if (signal) reject(new Error(`vinext build terminated by signal ${signal}.`));
      else resolve(value ?? 1);
    });
  });
  if (code !== 0) throw new Error(`vinext build exited with status ${code}.`);
}

async function finalizeSitesOutput(assets: readonly ChunkedAssetRecord[]): Promise<void> {
  for (const asset of assets) await rm(path.join(clientRoot, asset.path.slice(1)));
  await removeVerifiedBrowserOnlyDuplicatesFromServer();
  const manifest = JSON.parse(await readFile(path.join(clientRoot, "toolchains", manifestName), "utf8"));
  if (manifest.schema !== `${WASM_OJ_CONTRACT_ID}/sites-toolchain-chunks`
    || JSON.stringify(manifest.assets) !== JSON.stringify(assets)) {
    throw new Error("vinext output does not contain the exact staged Sites chunk manifest.");
  }
  for (const asset of assets) {
    const parts: Uint8Array[] = [];
    for (const chunk of asset.chunks) {
      const bytes = new Uint8Array(await readFile(path.join(clientRoot, chunk.path.slice(1))));
      if (bytes.byteLength !== chunk.byteLength || sha256(bytes) !== chunk.sha256) {
        throw new Error(`Sites output chunk '${chunk.path}' failed read-back verification.`);
      }
      parts.push(bytes);
    }
    const reconstructed = concatenate(parts, asset.byteLength);
    requireDigest(asset.path, reconstructed, asset.sha256);
  }
  for (const relative of await recursiveFiles(distRoot)) {
    const size = (await stat(path.join(distRoot, relative))).size;
    if (size > providerFileLimit) {
      throw new Error(`Sites output '${relative}' is ${size} bytes and exceeds the ${providerFileLimit}-byte provider limit.`);
    }
  }
  const serverBytes = await directoryBytes(path.join(distRoot, "server"));
  if (serverBytes > providerWorkerLimit) {
    throw new Error(`Sites Worker modules total ${serverBytes} bytes and exceed the ${providerWorkerLimit}-byte provider limit.`);
  }
  process.stdout.write(`Prepared ${assets.length} chunked Sites toolchains in ${assets.reduce((total, item) => total + item.chunks.length, 0)} verified parts.\n`);
}

async function removeVerifiedBrowserOnlyDuplicatesFromServer(): Promise<void> {
  const serverRoots = [
    path.join(distRoot, "server/_next/static"),
    path.join(distRoot, "server/ssr/_next/static"),
  ];
  const clientAssets = path.join(clientRoot, "_next/static");
  for (const directory of serverRoots) {
    const entries = await readdir(directory);
    const wasmNames = entries.filter((name) => name.endsWith(".wasm"));
    const sdkRuntimeNames = entries.filter((name) => name.startsWith("wasmer-sdk-"));
    const monacoWorkerNames = entries.filter((name) => /^(?:css|editor|html|json|ts)\.worker-.*\.js$/.test(name));
    for (const name of wasmNames) {
      if (!/^runtime-core_bg-[A-Za-z0-9_-]+\.wasm$/.test(name)) {
        throw new Error(`Sites build emitted unexpected server Wasm module '${name}'.`);
      }
    }
    for (const name of monacoWorkerNames) {
      if (!/^(?:css|editor|html|json|ts)\.worker-[A-Za-z0-9_-]+\.js$/.test(name)) {
        throw new Error(`Sites build emitted an invalid Monaco Worker asset '${name}'.`);
      }
    }
    const expectedMonacoWorkers = ["css", "editor", "html", "json", "ts"];
    const actualMonacoWorkers = monacoWorkerNames
      .map((name) => name.slice(0, name.indexOf(".worker-")))
      .sort();
    if (JSON.stringify(actualMonacoWorkers) !== JSON.stringify(expectedMonacoWorkers)) {
      throw new Error(`Sites build emitted an incomplete or duplicate Monaco Worker set in '${path.relative(root, directory)}'.`);
    }
    for (const name of sdkRuntimeNames) {
      if (!/^wasmer-sdk-[0-9a-f]{16}$/.test(name)) {
        throw new Error(`Sites build emitted an invalid Wasmer SDK runtime directory '${name}'.`);
      }
      for (const relative of await recursiveFiles(path.join(directory, name))) {
        const [serverBytes, clientBytes] = await Promise.all([
          readFile(path.join(directory, name, relative)),
          readFile(path.join(clientAssets, name, relative)),
        ]);
        if (serverBytes.byteLength !== clientBytes.byteLength
          || sha256(serverBytes) !== sha256(clientBytes)) {
          throw new Error(`Server browser-only module '${name}/${relative}' is not identical to its browser-static copy.`);
        }
      }
      await rm(path.join(directory, name), { recursive: true });
    }
    for (const name of [...wasmNames, ...monacoWorkerNames]) {
      const [serverBytes, clientBytes] = await Promise.all([
        readFile(path.join(directory, name)),
        readFile(path.join(clientAssets, name)),
      ]);
      if (serverBytes.byteLength !== clientBytes.byteLength
        || sha256(serverBytes) !== sha256(clientBytes)) {
        throw new Error(`Server browser-only module '${name}' is not identical to its browser-static copy.`);
      }
      await rm(path.join(directory, name));
    }
  }
}

async function cleanupStaging(): Promise<void> {
  const names = new Set(generatedNames);
  for (const name of await readdir(publicToolchainRoot)) {
    if (name === manifestName || name.includes(".wasm-oj-chunk-")) names.add(name);
  }
  await Promise.all([...names].map((name) => rm(path.join(publicToolchainRoot, name), { force: true })));
  generatedNames.length = 0;
}

async function recursiveFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const relative of await recursiveFiles(directory)) {
    total += (await stat(path.join(directory, relative))).size;
    if (!Number.isSafeInteger(total)) throw new Error("Sites Worker module size exceeds the safe integer range.");
  }
  return total;
}

function concatenate(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== byteLength) throw new Error("Sites toolchain chunks do not cover their declared byte length.");
  return result;
}

function requireDigest(label: string, bytes: Uint8Array, expected: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`Pinned Sites toolchain '${label}' has digest ${actual}; expected ${expected}.`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareEntries(left: [string, string], right: [string, string]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
