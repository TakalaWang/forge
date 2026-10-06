import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

export const WASMER_SDK_VIRTUAL_MODULE = "virtual:wasm-oj/wasmer-sdk";
const RESOLVED_VIRTUAL_MODULE = `\0${WASMER_SDK_VIRTUAL_MODULE}`;
const SDK_ROOT = path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.resolve("@wasmer/sdk/browser")))));
const ENTRY = "dist/index.js";
const BINDING = "pkg/wasmer_sdk_js.js";
const ROOTS = [ENTRY, "dist/browser-worker.js", "pkg/wasmer_sdk_js_bg.wasm"];
// Only the browser WISP networking mode loads this module, and it is the SDK's
// sole path to the AGPL-3.0 `@mercuryworkshop/wisp-js` package. WASM-OJ
// sandboxes run with networking disabled, so the module is not shipped.
const EXCLUDED = new Set(["dist/wisp-network.js"]);
const DYNAMIC_FUNCTION = "new Function(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3))";
// Wasmer's web backend builds every dynamic host-function trampoline from this
// fixed source through `new Function`, which a strict CSP rejects as eval.
const CSP_SAFE_FUNCTION = `
function __wasmOjFunction(parameters, body) {
  if (parameters === "f" && body === "return f(Array.prototype.slice.call(arguments, 1))") {
    return function (f) { return f(Array.prototype.slice.call(arguments, 1)); };
  }
  return new Function(parameters, body);
}
`;

/**
 * The SDK's browser entry, its Worker entry and their relative module graph,
 * keyed by package-relative path. These files load each other through
 * `import.meta.url`, so they are shipped unbundled with their layout intact.
 */
export async function wasmerSdkRuntimeFiles() {
  await init;
  const files = new Map();
  const visit = async (relative) => {
    if (files.has(relative) || EXCLUDED.has(relative)) return;
    const source = cspSafeRuntimeSource(relative, await readFile(path.join(SDK_ROOT, relative)));
    files.set(relative, source);
    if (!relative.endsWith(".js") && !relative.endsWith(".mjs")) return;
    const directory = path.posix.dirname(relative);
    for (const { n: specifier } of parse(source.toString("utf8"), relative)[0]) {
      if (specifier === undefined) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`@wasmer/sdk runtime module '${relative}' imports bare specifier '${specifier}'.`);
      }
      await visit(path.posix.normalize(path.posix.join(directory, specifier)));
    }
    if (relative.startsWith("pkg/snippets/")) {
      for (const name of await readdir(path.join(SDK_ROOT, directory))) {
        if (name.endsWith(".LICENSE")) files.set(path.posix.join(directory, name), await readFile(path.join(SDK_ROOT, directory, name)));
      }
    }
  };
  for (const root of ROOTS) await visit(root);
  return new Map([...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function cspSafeRuntimeSource(relative, source) {
  if (relative !== BINDING) return source;
  const text = source.toString("utf8");
  if (text.split(DYNAMIC_FUNCTION).length !== 2) {
    throw new Error(`@wasmer/sdk '${BINDING}' no longer contains exactly one dynamic Function constructor.`);
  }
  return Buffer.from(`${text.replace(DYNAMIC_FUNCTION, "__wasmOjFunction(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3))")}${CSP_SAFE_FUNCTION}`);
}

/**
 * Ships the official SDK runtime files as content-addressed assets and exposes
 * their URLs through `virtual:wasm-oj/wasmer-sdk`. Browser Workers import the
 * SDK from those URLs instead of bundling it.
 */
export function wasmerSdkRuntime() {
  let command = "build";
  let assetsDir = "assets";
  return {
    name: "wasm-oj-wasmer-sdk-runtime",
    config: () => ({ optimizeDeps: { exclude: ["@wasmer/sdk"] } }),
    configResolved(config) {
      command = config.command;
      assetsDir = config.build.assetsDir;
    },
    resolveId: (id) => (id === WASMER_SDK_VIRTUAL_MODULE ? RESOLVED_VIRTUAL_MODULE : null),
    transform(code, id) {
      if (command !== "serve" || id.split("?", 1)[0] !== path.join(SDK_ROOT, BINDING)) return null;
      return { code: cspSafeRuntimeSource(BINDING, Buffer.from(code)).toString("utf8"), map: null };
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE) return null;
      if (command === "serve") {
        const url = (relative) => JSON.stringify(`/@fs${path.join(SDK_ROOT, relative).split(path.sep).join("/")}`);
        return `export const wasmerSdkEntryUrl = ${url(ENTRY)};\nexport const wasmerSdkBindingUrl = ${url(BINDING)};\n`;
      }
      const files = await wasmerSdkRuntimeFiles();
      const hash = createHash("sha256");
      for (const [relative, source] of files) hash.update(relative).update("\0").update(source).update("\0");
      const directory = path.posix.join(assetsDir, `wasmer-sdk-${hash.digest("hex").slice(0, 16)}`);
      const references = new Map();
      for (const [relative, source] of files) {
        references.set(relative, this.emitFile({ type: "asset", fileName: `${directory}/${relative}`, source }));
      }
      return `export const wasmerSdkEntryUrl = import.meta.ROLLUP_FILE_URL_${references.get(ENTRY)};\n`
        + `export const wasmerSdkBindingUrl = import.meta.ROLLUP_FILE_URL_${references.get(BINDING)};\n`;
    },
  };
}
