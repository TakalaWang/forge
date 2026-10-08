import { describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash";
import {
  decodeRuntimeFiles,
  readRuntimeFilesExport,
  verifyAndDecodeRuntimeFiles,
} from "./runtime-files";

const encoder = new TextEncoder();

function archive(entries: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode("WOJFS002")];
  for (const [path, value] of entries) {
    const encodedPath = encoder.encode(path);
    const data = encoder.encode(value);
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, encodedPath.byteLength, true);
    view.setBigUint64(4, BigInt(data.byteLength), true);
    chunks.push(header, encodedPath, data);
  }
  chunks.push(new Uint8Array(12));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("runtime file archives", () => {
  it("decodes absolute runtime files", () => {
    const files = decodeRuntimeFiles(archive([
      ["/cpython/lib/python3.14/encodings/__init__.py", "codec"],
      ["/cpython/lib/python3.14/os.py", "os"],
    ]));
    expect(new TextDecoder().decode(files["/cpython/lib/python3.14/os.py"])).toBe("os");
  });

  it("rejects traversal and duplicate entries", () => {
    expect(() => decodeRuntimeFiles(archive([["/cpython/../escape", "x"]]))).toThrow("unsafe path");
    expect(() => decodeRuntimeFiles(archive([["/same", "x"], ["/same", "y"]]))).toThrow("duplicate");
  });

  it("rejects the retired archive signature", () => {
    const retired = archive([["/same", "x"]]);
    retired.set(new Uint8Array([0x4c, 0x57, 0x46, 0x53, 0x31]));
    expect(() => decodeRuntimeFiles(retired)).toThrow("invalid signature");
  });

  it("binds archive contents to the expected SHA-256 before decoding", async () => {
    const canonical = archive([["/cpython/lib/python314.zip", "stdlib"]]);
    const expected = await sha256Hex(canonical);
    const files = await verifyAndDecodeRuntimeFiles(canonical, expected);
    expect(new TextDecoder().decode(files["/cpython/lib/python314.zip"])).toBe("stdlib");

    const corrupted = canonical.slice();
    corrupted[corrupted.byteLength - 13] ^= 1;
    await expect(verifyAndDecodeRuntimeFiles(corrupted, expected)).rejects.toThrow(
      `expected ${expected}`,
    );
  });
});

function outputStream(chunks: readonly Uint8Array[], end: boolean) {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (end) controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }
  return chunks;
}

describe("runtime file exports", () => {
  it("returns a complete archive even when stdout and stderr never reach EOF", async () => {
    const expected = archive([
      ["/cpython/lib/python314.zip", "stdlib".repeat(100)],
      ["/cpython/lib/python3.14/os.py", "os"],
    ]);
    const stdout = outputStream(split(expected, 7), false);
    const stderr = outputStream([], false);
    let stdinClosed = false;

    const bytes = await readRuntimeFilesExport({
      stdin: new WritableStream({ close: () => { stdinClosed = true; } }),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(bytes).toEqual(expected);
    expect(stdinClosed).toBe(true);
    expect(stdout.state.cancelled).toBe(true);
    expect(stderr.state.cancelled).toBe(true);
  });

  it("reports stderr when stdout ends before the archive is complete", async () => {
    const complete = archive([["/cpython/lib/python314.zip", "stdlib"]]);
    await expect(readRuntimeFilesExport({
      stdout: outputStream([complete.subarray(0, complete.byteLength - 1)], true).stream,
      stderr: outputStream([encoder.encode("Traceback: boom")], true).stream,
    })).rejects.toThrow("Traceback: boom");
  });

  it("reports stderr after the idle grace when only stderr reaches EOF", async () => {
    const complete = archive([["/cpython/lib/python314.zip", "stdlib"]]);
    const stdout = outputStream([complete.subarray(0, 20)], false);
    await expect(readRuntimeFilesExport({
      stdout: stdout.stream,
      stderr: outputStream([encoder.encode("MemoryError")], true).stream,
    }, 30)).rejects.toThrow("ended before its archive was complete: MemoryError");
    expect(stdout.state.cancelled).toBe(true);
  });

  it("keeps reading while stdout still delivers after stderr reached EOF", async () => {
    const expected = archive([["/cpython/lib/python314.zip", "stdlib".repeat(100)]]);
    const chunks = split(expected, 32);
    const stdout = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
    });
    // The 100 ms grace is shorter than the whole delivery but longer than each gap between chunks.
    await expect(readRuntimeFilesExport({
      stdout,
      stderr: outputStream([], true).stream,
    }, 100)).resolves.toEqual(expected);
  });

  it("returns exactly the framed archive whatever trails it in the same chunk", async () => {
    const expected = archive([["/cpython/lib/python314.zip", "stdlib"]]);
    const trailing = new Uint8Array([...expected, ...encoder.encode("TRAILING")]);
    for (const chunks of [[trailing], split(trailing, 5)]) {
      const bytes = await readRuntimeFilesExport({
        stdout: outputStream(chunks, false).stream,
        stderr: outputStream([], false).stream,
      });
      expect(bytes).toEqual(expected);
    }
  });
});
