import type { Sandbox } from "@wasmer/sdk";
import { isLlvmBitcode, selectRustAllocatorBitcodeName } from "./rust-allocator-bitcode.ts";
import { RUST_COMPILE_TIMEOUT_MS } from "./rust-toolchain.ts";
import { runSandboxCommand, type SandboxCommandState } from "./sandbox-command.ts";

export const RUST_GUEST_ROOT = "/workspace";
const decoder = new TextDecoder();

export interface RustStageOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  outputPath: string;
  stage: string;
  requiresAllocatorBitcode?: boolean;
  outputValidator?: (bytes: Uint8Array) => boolean;
}

export interface RustStageObservation {
  success: boolean;
  bytes?: Uint8Array;
  allocatorBitcodePath?: string;
  stdout: string;
  stderr: string;
}

/** Run one rustc or wasm-ld process to exit and read its output. */
export async function runRustStage(
  sandbox: Sandbox,
  state: SandboxCommandState,
  options: RustStageOptions,
): Promise<RustStageObservation> {
  const validator = options.outputValidator ?? ((bytes: Uint8Array) => WebAssembly.validate(new Uint8Array(bytes)));
  const output = await runSandboxCommand(sandbox, state, {
    command: options.command,
    args: options.args,
    cwd: RUST_GUEST_ROOT,
    env: options.env,
    timeoutMs: RUST_COMPILE_TIMEOUT_MS,
    timeoutMessage: `${options.stage} exceeded ${RUST_COMPILE_TIMEOUT_MS} ms.`,
  });
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  if (!output.ok) return { success: false, stdout, stderr };
  const bytes = await readValidOutput(sandbox, options.outputPath, validator);
  const allocator = options.requiresAllocatorBitcode ? await readRustAllocatorBitcode(sandbox) : undefined;
  if (!bytes || (options.requiresAllocatorBitcode && !allocator)) {
    return { success: false, stdout, stderr: stderr || `${options.stage} exited without its complete output.\n` };
  }
  return { success: true, bytes, allocatorBitcodePath: allocator?.path, stdout, stderr };
}

export function isRustArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8 && new TextDecoder().decode(bytes.subarray(0, 8)) === "!<arch>\n";
}

async function readValidOutput(
  sandbox: Sandbox,
  guestPath: string,
  validator: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array | undefined> {
  try {
    const bytes = await sandbox.fs.readFile(guestPath);
    return bytes.byteLength > 8 && validator(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function readRustAllocatorBitcode(sandbox: Sandbox): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  const directory = `${RUST_GUEST_ROOT}/build`;
  let name: string | undefined;
  try {
    name = selectRustAllocatorBitcodeName((await sandbox.fs.readDir(directory)).map((entry) => entry.name));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("rustc emitted multiple")) throw error;
    return undefined;
  }
  if (!name) return undefined;
  const bytes = await sandbox.fs.readFile(`${directory}/${name}`).catch(() => undefined);
  return bytes && isLlvmBitcode(bytes) ? { path: `${directory}/${name}`, bytes } : undefined;
}
