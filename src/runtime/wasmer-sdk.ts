import type { Wasmer, WasmerOptions } from "@wasmer/sdk";
import { wasmerSdkBindingUrl, wasmerSdkEntryUrl } from "virtual:wasm-oj/wasmer-sdk";
import { createModuleWorkerBootstrap, moduleWorkerBaseUrl } from "./module-worker";

type WasmerSdk = typeof import("@wasmer/sdk");

interface WasmerSdkBinding {
  setWorkerUrl(url: string): void;
}

let runtime: Promise<{ sdk: WasmerSdk; binding: WasmerSdkBinding; workerUrl: string }> | undefined;

/**
 * Create an SDK client from the shipped runtime files. The SDK's thread Workers
 * start from a same-origin blob bootstrap, like every WASM-OJ module Worker, so
 * hosts that omit COOP/COEP on static assets still run them.
 */
export async function createBrowserWasmer(options: WasmerOptions = {}): Promise<Wasmer> {
  runtime ??= (async () => {
    const baseUrl = moduleWorkerBaseUrl();
    const entryUrl = new URL(wasmerSdkEntryUrl, baseUrl);
    const [sdk, binding] = await Promise.all([
      import(/* @vite-ignore */ entryUrl.href) as Promise<WasmerSdk>,
      import(/* @vite-ignore */ new URL(wasmerSdkBindingUrl, baseUrl).href) as Promise<WasmerSdkBinding>,
    ]);
    return { sdk, binding, workerUrl: createModuleWorkerBootstrap(new URL("browser-worker.js", entryUrl)).url };
  })();
  const loaded = await runtime.catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  const wasmer = new loaded.sdk.Wasmer({ cache: false, ...options });
  await wasmer.ready();
  // Each client initialization resets the Worker URL to the SDK's own asset;
  // Workers start lazily, so replacing it here precedes every spawn.
  loaded.binding.setWorkerUrl(loaded.workerUrl);
  return wasmer;
}
