import type { CommandSelector, Sandbox } from "@wasmer/sdk";

export interface SandboxCommandState {
  /** Set when a process outlived its budget; its sandbox must not be closed. */
  abandoned: boolean;
}

export interface SandboxCommandRequest {
  command: CommandSelector;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  timeoutMessage?: string;
}

export interface SandboxCommandOutput {
  /** The process exited on its own with status zero. */
  ok: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/**
 * Run one sandbox process to exit with piped output. A guest trap (rustc exits
 * through `unreachable` after reporting errors) rejects the SDK's `wait()`, but
 * its streams still end, so the diagnostics survive as an unsuccessful result.
 *
 * A process that exceeds `timeoutMs` is abandoned rather than killed: the caller
 * discards the whole Worker or child process, which avoids SDK termination of a
 * thread that may hold the shared allocator lock.
 */
export async function runSandboxCommand(
  sandbox: Sandbox,
  state: SandboxCommandState,
  request: SandboxCommandRequest,
): Promise<SandboxCommandOutput> {
  const child = await sandbox.command(request.command, [...request.args], {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
  }).spawn({ stdin: request.stdin === undefined ? "closed" : "pipe", stdout: "pipe", stderr: "pipe" });
  const completion = Promise.all([
    child.stdin && request.stdin !== undefined
      ? child.stdin.write(request.stdin).then(() => child.stdin!.close())
      : undefined,
    readAll(child.stdout),
    readAll(child.stderr),
    child.wait({ check: false }).then((output) => output.ok, () => false),
  ]);
  void completion.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [, stdout, stderr, ok] = request.timeoutMs === undefined
      ? await completion
      : await Promise.race([
          completion,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              state.abandoned = true;
              reject(new Error(request.timeoutMessage ?? `The sandbox process exceeded ${request.timeoutMs} ms.`));
            }, request.timeoutMs);
          }),
        ]);
    return { ok, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function readAll(stream: AsyncIterable<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
