import { describe, expect, it } from "vitest";
import { completeJsonObject, readProcessMessage } from "./process-output";

const encoder = new TextEncoder();

function pipe() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (value) => { controller = value; } });
  return {
    stream,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("process output messages", () => {
  it("completes a JSON response without stdout or stderr EOF and keeps late stderr", async () => {
    const stdout = pipe();
    const stderr = pipe();
    const result = readProcessMessage<{ status: number; text: string }>(
      { stdout: stdout.stream, stderr: stderr.stream },
      completeJsonObject,
      { collectStderr: true, idleGraceMs: 50 },
    );
    // A chunk boundary right after a `}` inside a string must not complete the response.
    stdout.write('{"status":0,"text":"f() {}');
    stdout.write('"}\n');
    await delay(10);
    stderr.write("warning: late");
    await expect(result).resolves.toEqual({
      message: { status: 0, text: "f() {}" },
      stderr: "warning: late",
    });
  });

  it("returns as soon as stderr ends after the response completes", async () => {
    const stdout = pipe();
    const stderr = pipe();
    const started = performance.now();
    const result = readProcessMessage(
      { stdout: stdout.stream, stderr: stderr.stream },
      completeJsonObject,
      { collectStderr: true, idleGraceMs: 60_000 },
    );
    stdout.write('{"status":0}');
    stderr.close();
    await expect(result).resolves.toEqual({ message: { status: 0 }, stderr: "" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("gives up after the idle grace once stdout ended without a complete response", async () => {
    const stdout = pipe();
    const stderr = pipe();
    const result = readProcessMessage(
      { stdout: stdout.stream, stderr: stderr.stream },
      completeJsonObject,
      { idleGraceMs: 30 },
    );
    stdout.write('{"status":');
    stderr.write("panic: out of memory");
    stdout.close();
    await expect(result).resolves.toEqual({ message: undefined, stderr: "panic: out of memory" });
  });

  it("keeps waiting while both streams are open", async () => {
    const stdout = pipe();
    const stderr = pipe();
    const result = readProcessMessage(
      { stdout: stdout.stream, stderr: stderr.stream },
      completeJsonObject,
      { idleGraceMs: 10 },
    );
    stdout.write('{"status":');
    const early = await Promise.race([result, delay(100).then(() => "pending")]);
    expect(early).toBe("pending");
    stdout.write("0}");
    await expect(result).resolves.toEqual({ message: { status: 0 }, stderr: "" });
  });
});
