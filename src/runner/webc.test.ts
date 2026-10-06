import { describe, expect, it } from "vitest";
import { readWebcAtom } from "./webc";

const encoder = new TextEncoder();

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function webc(atoms: Record<string, Uint8Array>): Uint8Array {
  const names = Object.keys(atoms);
  const data = concat(...Object.values(atoms));
  const entryBytes = names.map((name) => 8 + 32 + 8 + encoder.encode(name).byteLength);
  const directoryLength = 3 * 8 + 32 + entryBytes.reduce((total, size) => total + size, 0);
  let fileOffset = 1 + 8 + directoryLength;
  let dataOffset = 0;
  const entries: Uint8Array[] = [];
  const files: Uint8Array[] = [];
  for (const name of names) {
    const encoded = encoder.encode(name);
    entries.push(u64(fileOffset), new Uint8Array(32), u64(encoded.byteLength), encoded);
    const size = atoms[name]!.byteLength;
    files.push(Uint8Array.of(31), u64(dataOffset), u64(dataOffset + size), new Uint8Array(32 + 3 * 8));
    fileOffset += 1 + 8 + 8 + 32 + 3 * 8;
    dataOffset += size;
  }
  const header = concat(Uint8Array.of(30), u64(directoryLength), new Uint8Array(3 * 8 + 32), ...entries, ...files);
  const atomsSection = concat(u64(header.byteLength), header, u64(data.byteLength), data);
  const manifest = encoder.encode("manifest");
  return concat(
    encoder.encode("\0webc003"),
    Uint8Array.of(2), u64(4), encoder.encode("idx!"),
    Uint8Array.of(1), new Uint8Array(32), u64(manifest.byteLength), manifest,
    Uint8Array.of(3), new Uint8Array(32), u64(atomsSection.byteLength), atomsSection,
  );
}

describe("WEBC atom reader", () => {
  it("returns the named atom's exact bytes", () => {
    const python = encoder.encode("\0asm-python-module");
    const container = webc({ helper: encoder.encode("other"), python });
    expect(readWebcAtom(container, "python")).toEqual(python);
    expect(readWebcAtom(container, "helper")).toEqual(encoder.encode("other"));
  });

  it("rejects foreign containers, missing atoms, and truncated sections", () => {
    const container = webc({ python: encoder.encode("module") });
    expect(() => readWebcAtom(encoder.encode("\0webc002........"), "python")).toThrow("not a WEBC v3");
    expect(() => readWebcAtom(container, "rustc")).toThrow("no 'rustc' atom");
    expect(() => readWebcAtom(container.subarray(0, container.byteLength - 3), "python")).toThrow("truncated");
  });
});
