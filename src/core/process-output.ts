/** How long a read waits for new bytes once the guest has exited or the message is complete. */
export const PROCESS_OUTPUT_IDLE_GRACE_MS = 2_000;

export interface StreamingProcess {
  readonly stdin?: WritableStream | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export interface ProcessMessageOptions {
  readonly idleGraceMs?: number | undefined;
  /** Keep reading stderr after the message completes, until EOF or the idle grace. */
  readonly collectStderr?: boolean | undefined;
}

export interface ProcessMessage<T> {
  /** The parsed stdout message, or undefined when the process stopped before completing it. */
  readonly message: T | undefined;
  readonly stderr: string;
}

type ReadEvent = { readonly source: "stdout" | "stderr"; readonly chunk?: Uint8Array } | { readonly source: "idle" };

/**
 * Read stdout until `parse` recognizes one complete self-delimiting message.
 *
 * `@wasmer/sdk` 0.10 `Instance.wait()` joins stdout EOF, stderr EOF and the exit code, and its
 * thread-pool teardown can drop either EOF after all output arrived, so `wait()` never settles.
 * Completion therefore comes from the message itself. Either EOF means the guest exited, so the
 * other stream then gets `idleGraceMs` without new bytes before the read stops. If both EOFs are
 * lost before the message completes, the caller's own deadline still bounds the read.
 */
export async function readProcessMessage<T>(
  child: StreamingProcess,
  parse: (stdout: Uint8Array) => T | undefined,
  options: ProcessMessageOptions = {},
): Promise<ProcessMessage<T>> {
  const idleGraceMs = options.idleGraceMs ?? PROCESS_OUTPUT_IDLE_GRACE_MS;
  await child.stdin?.close().catch(() => undefined);
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const nextStdout = () => stdoutReader.read()
    .then(({ done, value }): ReadEvent => ({ source: "stdout", chunk: done ? undefined : value }));
  const nextStderr = () => stderrReader.read()
    .then(({ done, value }): ReadEvent => ({ source: "stderr", chunk: done ? undefined : value }))
    .catch((): ReadEvent => ({ source: "stderr" }));
  const stdout = byteBuffer();
  const stderr = byteBuffer();
  let stdoutRead: Promise<ReadEvent> | undefined = nextStdout();
  let stderrRead: Promise<ReadEvent> | undefined = nextStderr();
  let message: T | undefined;
  try {
    while (true) {
      const complete = message !== undefined;
      const reads = complete ? [options.collectStderr ? stderrRead : undefined] : [stdoutRead, stderrRead];
      const pending = reads.filter((read): read is Promise<ReadEvent> => read !== undefined);
      if (pending.length === 0) break;
      // While both streams are open and the message is incomplete, the guest may still be running.
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (complete || pending.length === 1) {
        pending.push(new Promise((resolve) => {
          timer = setTimeout(() => resolve({ source: "idle" }), idleGraceMs);
        }));
      }
      const event = await Promise.race(pending).finally(() => clearTimeout(timer));
      if (event.source === "idle") break;
      if (event.source === "stdout") {
        if (!event.chunk) {
          stdoutRead = undefined;
          continue;
        }
        stdout.append(event.chunk);
        message = parse(stdout.bytes());
        stdoutRead = message === undefined ? nextStdout() : undefined;
      } else if (!event.chunk) {
        stderrRead = undefined;
      } else {
        stderr.append(event.chunk);
        stderrRead = nextStderr();
      }
    }
  } finally {
    await Promise.allSettled([stdoutReader.cancel(), stderrReader.cancel()]);
  }
  return { message, stderr: new TextDecoder().decode(stderr.bytes()) };
}

const JSON_WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

/** Parse stdout once it holds one complete JSON object, optionally followed by whitespace. */
export function completeJsonObject<T>(stdout: Uint8Array): T | undefined {
  let end = stdout.byteLength;
  while (end > 0 && JSON_WHITESPACE.has(stdout[end - 1])) end -= 1;
  // Only output ending in `}` can hold the whole object, which keeps parse attempts rare.
  if (end === 0 || stdout[end - 1] !== 0x7d) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(stdout.subarray(0, end))) as T;
  } catch {
    return undefined;
  }
}

/** An append-only byte buffer that grows geometrically, so appending chunks stays linear. */
function byteBuffer() {
  let buffer = new Uint8Array(0);
  let length = 0;
  return {
    append(chunk: Uint8Array): void {
      if (length + chunk.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.max(length + chunk.byteLength, buffer.byteLength * 2));
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(chunk, length);
      length += chunk.byteLength;
    },
    bytes: (): Uint8Array => buffer.subarray(0, length),
  };
}
