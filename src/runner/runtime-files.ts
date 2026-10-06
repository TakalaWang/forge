import { WASM_OJ_STORAGE } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";

const MAGIC = new TextEncoder().encode("WOJFS002");
const HEADER_BYTES = 12;

export const PYTHON_RUNTIME_FILES_CACHE_KEY = `${WASM_OJ_STORAGE.runtimeFilesCache}:cpython-3.14.7-wasip1-stdlib-stored-zip`;

export const PYTHON_RUNTIME_FILES_EXPORT_SCRIPT = String.raw`
import io
import os
import sys
import zipfile

source_root = "/usr/local/lib/python3.14"
guest_path = "/cpython/lib/python314.zip"
output = sys.stdout.buffer
output.write(b"WOJFS002")

archive_buffer = io.BytesIO()
with zipfile.ZipFile(archive_buffer, "w", compression=zipfile.ZIP_STORED) as archive:
    for root, directories, files in os.walk(source_root):
        directories[:] = sorted(
            name for name in directories
            if name != "__pycache__" and not os.path.islink(os.path.join(root, name))
        )
        for name in sorted(files):
            source_path = os.path.join(root, name)
            if os.path.islink(source_path) or name.endswith((".pyc", ".pyo")):
                continue
            archive_path = os.path.relpath(source_path, source_root).replace(os.sep, "/")
            info = zipfile.ZipInfo(archive_path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            with open(source_path, "rb") as source:
                archive.writestr(info, source.read())

encoded_path = guest_path.encode("utf-8")
archive_data = archive_buffer.getvalue()
output.write(len(encoded_path).to_bytes(4, "little"))
output.write(len(archive_data).to_bytes(8, "little"))
output.write(encoded_path)
output.write(archive_data)

output.write((0).to_bytes(4, "little"))
output.write((0).to_bytes(8, "little"))
`;

function safeRuntimePath(path: string): boolean {
  return path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("//")
    && !path.endsWith("/")
    && !path.split("/").some((component) => component === "." || component === "..");
}

export function decodeRuntimeFiles(archive: Uint8Array): Record<string, Uint8Array> {
  if (archive.byteLength < MAGIC.byteLength + HEADER_BYTES) {
    throw new Error("Runtime file archive is truncated.");
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (archive[index] !== MAGIC[index]) throw new Error("Runtime file archive has an invalid signature.");
  }

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: Record<string, Uint8Array> = {};
  let offset = MAGIC.byteLength;

  while (true) {
    if (offset + HEADER_BYTES > archive.byteLength) {
      throw new Error("Runtime file archive ended inside an entry header.");
    }
    const pathLength = view.getUint32(offset, true);
    const dataLength = Number(view.getBigUint64(offset + 4, true));
    offset += HEADER_BYTES;
    if (pathLength === 0 && dataLength === 0) break;
    if (pathLength === 0 || !Number.isSafeInteger(dataLength)) {
      throw new Error("Runtime file archive contains an invalid entry size.");
    }
    const end = offset + pathLength + dataLength;
    if (!Number.isSafeInteger(end) || end > archive.byteLength) {
      throw new Error("Runtime file archive entry exceeds the archive boundary.");
    }
    const path = decoder.decode(archive.subarray(offset, offset + pathLength));
    offset += pathLength;
    if (!safeRuntimePath(path)) throw new Error(`Runtime file archive contains an unsafe path: '${path}'.`);
    if (Object.hasOwn(files, path)) throw new Error(`Runtime file archive contains duplicate path '${path}'.`);
    files[path] = archive.slice(offset, offset + dataLength);
    offset += dataLength;
  }

  if (offset !== archive.byteLength) {
    throw new Error("Runtime file archive contains trailing bytes.");
  }
  return files;
}

export interface RuntimeFilesExportProcess {
  readonly stdin?: WritableStream | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

/**
 * Read an export until stdout holds a complete archive. `@wasmer/sdk` `Instance.wait()` also
 * waits for stdout/stderr EOF, which its thread-pool teardown can drop after all output arrived.
 */
export async function readRuntimeFilesExport(exporter: RuntimeFilesExportProcess): Promise<Uint8Array> {
  await exporter.stdin?.close().catch(() => undefined);
  const stdout = exporter.stdout.getReader();
  const stderr = exporter.stderr.getReader();
  const diagnostics = readToEnd(stderr).catch(() => new Uint8Array());
  const chunks: Uint8Array[] = [];
  let received = 0;
  let required = MAGIC.byteLength + HEADER_BYTES;
  try {
    while (true) {
      const { done, value } = await stdout.read();
      if (done) {
        const detail = new TextDecoder().decode(await diagnostics);
        throw new Error(`The runtime file export ended before its archive was complete: ${detail}`);
      }
      chunks.push(value);
      received += value.byteLength;
      if (received < required) continue;
      const archive = concatenate(chunks);
      chunks.splice(0, chunks.length, archive);
      const missing = missingArchiveBytes(archive);
      if (missing === 0) return archive;
      required = received + missing;
    }
  } finally {
    await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
  }
}

function missingArchiveBytes(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = MAGIC.byteLength;
  while (offset + HEADER_BYTES <= archive.byteLength) {
    const pathLength = view.getUint32(offset, true);
    const dataLength = Number(view.getBigUint64(offset + 4, true));
    offset += HEADER_BYTES;
    if (pathLength === 0 && dataLength === 0) return 0;
    offset += pathLength + dataLength;
  }
  return offset + HEADER_BYTES - archive.byteLength;
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return concatenate(chunks);
    chunks.push(value);
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function verifyAndDecodeRuntimeFiles(
  archive: Uint8Array,
  expectedSha256: string,
): Promise<Record<string, Uint8Array>> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Runtime file archive expected SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  const actual = await sha256Hex(archive);
  if (actual !== expectedSha256) {
    throw new Error(`Runtime file archive has digest ${actual}; expected ${expectedSha256}.`);
  }
  return decodeRuntimeFiles(archive);
}
