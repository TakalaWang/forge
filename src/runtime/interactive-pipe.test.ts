import { describe, expect, it } from "vitest";
import { createInteractivePipe, InteractivePipeReader, InteractivePipeWriter } from "./interactive-pipe";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("interactive pipe", () => {
  it("delivers bytes in order across the ring boundary", () => {
    const buffer = createInteractivePipe(8);
    const writer = new InteractivePipeWriter(buffer);
    const reader = new InteractivePipeReader(buffer);
    expect(writer.write(bytes("abcdef"))).toBe(6);
    expect(text(reader.read(4))).toBe("abcd");
    expect(writer.write(bytes("ghijkl"))).toBe(6);
    expect(reader.wait()).toBe(8);
    expect(text(reader.read(100))).toBe("efghijkl");
  });

  it("reports EOF only after buffered bytes are drained", () => {
    const buffer = createInteractivePipe(16);
    const writer = new InteractivePipeWriter(buffer);
    const reader = new InteractivePipeReader(buffer);
    writer.write(bytes("42\n"));
    writer.close();
    expect(text(reader.read(2))).toBe("42");
    expect(text(reader.read(2))).toBe("\n");
    expect(reader.wait()).toBe(0);
    expect(reader.read(2).byteLength).toBe(0);
  });

  it("fails writes once the reader has closed", () => {
    const buffer = createInteractivePipe(16);
    const writer = new InteractivePipeWriter(buffer);
    new InteractivePipeReader(buffer).close();
    expect(writer.write(bytes("ignored"))).toBe(-1);
  });

  it("keeps positions consistent when the 32-bit counters wrap", () => {
    const buffer = createInteractivePipe(8);
    const header = new Int32Array(buffer, 0, 8);
    header[0] = -3;
    header[1] = -3;
    const writer = new InteractivePipeWriter(buffer);
    const reader = new InteractivePipeReader(buffer);
    expect(writer.write(bytes("wrap!"))).toBe(5);
    expect(text(reader.read(8))).toBe("wrap!");
    expect(header[0]).toBe(2);
  });

  it("rejects capacities that are not powers of two", () => {
    expect(() => createInteractivePipe(12)).toThrow(/power of two/);
  });
});
