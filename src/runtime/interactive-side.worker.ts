/// <reference lib="webworker" />

import initRuntimeCore, {
  run_interactive_side as runInteractiveSide,
} from "@/src/runner/generated/runtime-core.js";
import { InteractivePipeReader, InteractivePipeWriter } from "./interactive-pipe";

export interface InteractiveSideStart {
  runtimeCore: WebAssembly.Module;
  request: unknown;
  input: SharedArrayBuffer;
  output: SharedArrayBuffer;
}

export type InteractiveSideMessage =
  | { type: "running" }
  | { type: "result"; response: unknown }
  | { type: "error"; message: string };

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: InteractiveSideMessage): void {
  scope.postMessage(message);
}

scope.addEventListener("message", (event: MessageEvent<InteractiveSideStart>) => {
  void runSide(event.data);
}, { once: true });

async function runSide(start: InteractiveSideStart): Promise<void> {
  const input = new InteractivePipeReader(start.input);
  const output = new InteractivePipeWriter(start.output);
  let response: unknown;
  try {
    await initRuntimeCore({ module_or_path: start.runtimeCore });
    response = runInteractiveSide(
      start.request,
      (maximum: number) => input.read(maximum),
      () => input.wait(),
      (bytes: Uint8Array) => output.write(bytes),
      (running: boolean) => {
        if (running) post({ type: "running" });
      },
    );
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return;
  } finally {
    output.close();
    input.close();
  }
  post({ type: "result", response });
}
