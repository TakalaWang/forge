import vinext from "vinext";
import { defineConfig, type UserConfig } from "vite";
import { sites } from "./build/sites-vite-plugin.ts";
import { wasmerSdkRuntime } from "./scripts/wasmer-sdk-runtime.mjs";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async (): Promise<UserConfig> => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    build: {
      modulePreload: { polyfill: false },
      target: "es2022",
    },
    worker: { format: "es" as const, plugins: () => [wasmerSdkRuntime()] },
    plugins: [
      vinext(),
      sites(),
      wasmerSdkRuntime(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        configPath: "./wrangler.jsonc",
      }),
    ],
  };
});
