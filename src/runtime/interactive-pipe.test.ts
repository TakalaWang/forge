import { describe, expect, it } from "vitest";
import {
  createInteractivePipe,
  interactivePipeCapacity,
  InteractivePipeReader,
  InteractivePipeWriter,
} from "./interactive-pipe";

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

  it("returns bytes the writer publishes and closes with after the reader saw an empty buffer", () => {
    const buffer = createInteractivePipe(16);
    const writer = new InteractivePipeWriter(buffer);
    class RacedReader extends InteractivePipeReader {
      private raced = false;

      protected override buffered(): number {
        const buffered = super.buffered();
        if (!this.raced) {
          this.raced = true;
          writer.write(bytes("42\n"));
          writer.close();
        }
        return buffered;
      }
    }
    const reader = new RacedReader(buffer);
    expect(text(reader.read(16))).toBe("42\n");
    expect(reader.read(16).byteLength).toBe(0);
  });

  it("polls without blocking", () => {
    const buffer = createInteractivePipe(16);
    const writer = new InteractivePipeWriter(buffer);
    const reader = new InteractivePipeReader(buffer);
    expect(reader.poll()).toBe(-1);
    writer.write(bytes("ok"));
    expect(reader.poll()).toBe(2);
    expect(text(reader.read(2))).toBe("ok");
    writer.close();
    expect(reader.poll()).toBe(0);
  });

  it("fails writes once the reader has closed", () => {
    const buffer = createInteractivePipe(16);
    const writer = new InteractivePipeWriter(buffer);
    new InteractivePipeReader(buffer).close();
    expect(writer.write(bytes("ignored"))).toBe(-1);
    expect(writer.write(new Uint8Array())).toBe(-1);
  });

  it("fails a write the reader closes on partway, like the server's broken pipe", () => {
    const buffer = createInteractivePipe(8);
    const reader = new InteractivePipeReader(buffer);
    class ClosedWhileBlocked extends InteractivePipeWriter {
      protected override sleep(): void {
        reader.read(4);
        reader.close();
      }
    }
    expect(new ClosedWhileBlocked(buffer).write(bytes("0123456789ab"))).toBe(-1);
  });

  it("sizes rings to hold the writer's whole output budget", () => {
    expect(interactivePipeCapacity(1024)).toBe(64 * 1024);
    expect(interactivePipeCapacity(4 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    expect(interactivePipeCapacity(4 * 1024 * 1024 + 1)).toBe(8 * 1024 * 1024);
    expect(interactivePipeCapacity(2 ** 40)).toBe(2 ** 30);
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
