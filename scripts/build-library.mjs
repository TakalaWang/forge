import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { build } from "vite";
import {
  PUBLIC_PACKAGE_BY_NAME,
  PUBLIC_PACKAGES,
  TOOLCHAIN_DESCRIPTOR_SCHEMA,
  WASM_OJ_CONTRACT_VERSION,
  WORKSPACE_PACKAGE_PATTERN,
  packagesRoot,
  repositoryRoot,
} from "./library-packages.mjs";
import { resolveTypeScriptCli } from "./typescript-cli.mjs";

import { buildQuickJsStdlib } from "./build-quickjs-stdlib.mjs";
import { wasmerSdkRuntime } from "./wasmer-sdk-runtime.mjs";

const run = promisify(execFile);
const alias = { "@": repositoryRoot };
const selection = selectedPackageName(process.argv.slice(2));
const selected = selection?.kind === "package"
  ? [requiredPackage(selection.name)]
  : selection?.kind === "group"
    ? PUBLIC_PACKAGES.filter((definition) => definition.kind === selection.name)
    : PUBLIC_PACKAGES;

if (selected.some((definition) => definition.kind !== "toolchain")) await buildQuickJsStdlib();

for (const definition of selected) {
  if (definition.kind === "toolchain") await buildToolchainPackage(definition);
  else await buildCodePackage(definition);
}

process.stdout.write(`Built ${selected.length} WASM-OJ public package${selected.length === 1 ? "" : "s"}.\n`);

function selectedPackageName(arguments_) {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length !== 2 || !arguments_[1]) {
    throw new Error("Usage: node scripts/build-library.mjs [--package @wasm-oj/<name> | --group code|toolchain]");
  }
  if (arguments_[0] === "--package") return { kind: "package", name: arguments_[1] };
  if (arguments_[0] === "--group" && (arguments_[1] === "code" || arguments_[1] === "toolchain")) {
    return { kind: "group", name: arguments_[1] };
  }
  throw new Error("Usage: node scripts/build-library.mjs [--package @wasm-oj/<name> | --group code|toolchain]");
}

function requiredPackage(name) {
  const definition = PUBLIC_PACKAGE_BY_NAME.get(name);
  if (!definition) throw new Error(`Unknown public package '${name}'.`);
  return definition;
}

async function buildCodePackage(definition) {
  const packageRoot = path.join(packagesRoot, definition.directory);
  const outDir = path.join(packageRoot, "dist");
  const stagingDir = await mkdtemp(path.join(packageRoot, ".wasm-oj-build-"));
  try {
    if (definition.sdk) await buildSdkFacade(stagingDir);
    else await buildSourcePackage(definition, stagingDir);
    await copyCommonFiles(packageRoot, definition.licenses);
    if (definition.server) await copyServerRuntimeSources(packageRoot);
    await verifyDeclarationBoundary(stagingDir, definition);
    await replaceDirectory(stagingDir, outDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function buildSourcePackage(definition, stagingDir) {
  const source = path.join(repositoryRoot, definition.source);
  await access(source);
  const sourceInput = definition.organizer
    ? { index: source }
    : { index: source };
  await build({
    configFile: false,
    base: "./",
    publicDir: false,
    plugins: definition.name === "@wasm-oj/contracts" ? [] : [contractsBoundaryPlugin()],
    resolve: { alias },
    worker: { format: "es", plugins: () => [wasmerSdkRuntime()] },
    build: {
      outDir: stagingDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      ssr: !definition.browser,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: sourceInput,
        preserveEntrySignatures: "strict",
        external: externalFor(definition),
        output: {
          entryFileNames: ({ name }) => name === "index" ? "index.js" : `${name}.js`,
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });

  if (definition.server) await buildServerStages(stagingDir, definition);
  await emitAndRollDeclarations(definition, stagingDir);
}

function externalFor(definition) {
  const runtimeDependencies = new Set(definition.runtimeDependencies ?? []);
  return (id) => {
    if (id.startsWith("node:")) return true;
    if (WORKSPACE_PACKAGE_PATTERN.test(id)) return true;
    for (const dependency of runtimeDependencies) {
      if (id === dependency || id.startsWith(`${dependency}/`)) return true;
    }
    return false;
  };
}

async function buildServerStages(stagingDir, definition) {
  const stages = [
    "server-build-stage",
    "server-runner-stage",
    "rustc-stage",
    "go-stage",
    "java-stage",
  ];
  await build({
    configFile: false,
    publicDir: false,
    plugins: [contractsBoundaryPlugin()],
    resolve: { alias },
    build: {
      outDir: stagingDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      ssr: true,
      rollupOptions: {
        input: Object.fromEntries(stages.map((name) => [name, path.join(repositoryRoot, `src/server/${name}.mjs`)])),
        external: externalFor(definition),
        output: {
          entryFileNames: "[name].mjs",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  });
}

async function emitAndRollDeclarations(definition, stagingDir) {
  const declarationRoot = await mkdtemp(path.join(path.dirname(stagingDir), ".wasm-oj-declarations-"));
  try {
    const source = path.join(repositoryRoot, definition.source);
    const sourceRelative = path.relative(repositoryRoot, source).split(path.sep).join("/");
    const config = {
      compilerOptions: {
        target: "ES2022",
        lib: ["DOM", "DOM.Iterable", "ESNext", "WebWorker"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        esModuleInterop: true,
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        incremental: false,
        rootDir: repositoryRoot,
        outDir: declarationRoot,
        types: ["node", "vite/client"],
      },
      files: [source],
    };
    const configFile = path.join(declarationRoot, "tsconfig.json");
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const typescript = await resolveTypeScriptCli();
    try {
      await run(process.execPath, [typescript, "--project", configFile, "--pretty", "false"], {
        cwd: repositoryRoot,
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
      const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(
        `${definition.name} declaration emit failed for '${sourceRelative}'.${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
        { cause: error },
      );
    }
    await verifyEmittedDeclarationInputs(declarationRoot);
    const emitted = path.join(declarationRoot, sourceRelative.replace(/\.ts$/u, ".d.ts"));
    const bundle = await rollup({
      input: emitted,
      external: externalFor(definition),
      plugins: [
        ...(definition.name === "@wasm-oj/contracts" ? [] : [contractsBoundaryPlugin(declarationRoot)]),
        dts({ tsconfig: configFile }),
      ],
      onwarn(warning) {
        throw new Error(`Declaration rollup warning (${warning.code}): ${warning.message}`);
      },
    });
    try {
      await bundle.write({ file: path.join(stagingDir, "index.d.ts"), format: "es" });
    } finally {
      await bundle.close();
    }
  } finally {
    await rm(declarationRoot, { recursive: true, force: true });
  }
}

function contractsBoundaryPlugin(declarationRoot) {
  const sourceTargets = new Set(["contract", "errors", "types"].map((name) => (
    path.join(repositoryRoot, "src", "core", `${name}.ts`)
  )));
  const declarationTargets = declarationRoot
    ? new Set(["contract", "errors", "types"].map((name) => (
        path.join(declarationRoot, "src", "core", `${name}.d.ts`)
      )))
    : new Set();
  return {
    name: "wasm-oj-contracts-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || (!source.startsWith(".") && !path.isAbsolute(source))) return null;
      const resolved = path.resolve(path.dirname(importer.split("?", 1)[0]), source);
      const candidates = [resolved, `${resolved}.ts`, `${resolved}.d.ts`];
      if (candidates.some((candidate) => sourceTargets.has(candidate) || declarationTargets.has(candidate))) {
        return { id: "@wasm-oj/contracts", external: true };
      }
      return null;
    },
  };
}

async function buildSdkFacade(stagingDir) {
  const entries = ["index", "contracts", "browser", "server", "organizer"];
  await mkdir(stagingDir, { recursive: true });
  for (const entry of entries) {
    const source = await readFile(path.join(packagesRoot, "sdk", "src", `${entry}.ts`), "utf8");
    await writeFile(path.join(stagingDir, `${entry}.js`), source);
    await writeFile(path.join(stagingDir, `${entry}.d.ts`), source);
  }
}

async function buildToolchainPackage(definition) {
  const packageRoot = path.join(packagesRoot, definition.directory);
  const stagingDir = await mkdtemp(path.join(packageRoot, ".wasm-oj-toolchain-"));
  try {
    const assetsDir = path.join(stagingDir, "assets");
    const distDir = path.join(stagingDir, "dist");
    await Promise.all([mkdir(assetsDir), mkdir(distDir)]);
    const assets = [];
    for (const filename of definition.assets) {
      const source = path.join(repositoryRoot, "public", "toolchains", filename);
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Toolchain asset must be a real regular file: '${source}'.`);
      }
      const bytes = await readFile(source);
      rejectLegacyToolchainAsset(filename, bytes);
      await copyFile(source, path.join(assetsDir, filename));
      assets.push(Object.freeze({
        path: `/toolchains/${filename}`,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        exportPath: `./assets/${filename}`,
      }));
    }
    const descriptor = Object.freeze({
      schema: TOOLCHAIN_DESCRIPTOR_SCHEMA,
      id: definition.id,
      version: definition.toolchainVersion,
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      languages: definition.languages,
      profiles: definition.profiles,
      assets: Object.freeze(assets),
    });
    await Promise.all([
      writeFile(path.join(distDir, "index.js"), toolchainJavaScript(descriptor)),
      writeFile(path.join(distDir, "index.d.ts"), toolchainDeclaration(descriptor)),
    ]);
    await replaceDirectory(assetsDir, path.join(packageRoot, "assets"));
    await replaceDirectory(distDir, path.join(packageRoot, "dist"));
    await copyCommonFiles(packageRoot, definition.licenses);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function rejectLegacyToolchainAsset(filename, bytes) {
  if (bytes.subarray(0, 43).toString("utf8") === "version https://git-lfs.github.com/spec/v1\n") {
    throw new Error(`Toolchain asset '${filename}' is an unresolved Git LFS pointer.`);
  }
  for (const forbidden of ["wasm-oj-forge-v1", "FORGEFS1", "forgeContract", "__FORGE_"]) {
    if (bytes.includes(forbidden)) {
      throw new Error(`Toolchain asset '${filename}' contains retired contract token '${forbidden}'.`);
    }
  }
}

function toolchainJavaScript(descriptor) {
  return [
    `export const descriptor = deepFreeze(${JSON.stringify(descriptor, null, 2)});`,
    "",
    "export function browserSource(baseUrl) {",
    "  return Object.freeze({ kind: \"browser\", descriptor, baseUrl: normalizeBrowserBaseUrl(baseUrl) });",
    "}",
    "",
    "export function serverSource() {",
    "  return Object.freeze({ kind: \"server\", descriptor, directory: new URL(\"../assets/\", import.meta.url) });",
    "}",
    "",
    "function normalizeBrowserBaseUrl(value) {",
    "  if (typeof value !== \"string\" || !value || value !== value.trim() || value.length > 4096 || value.startsWith(\"//\") || value.includes(\"#\")) {",
    "    throw new TypeError(\"Toolchain baseUrl must be a non-empty absolute or root-relative URL without a fragment.\");",
    "  }",
    "  let url;",
    "  if (value.startsWith(\"/\")) url = new URL(value, \"https://wasm-oj.invalid/\");",
    "  else {",
    "    try { url = new URL(value); } catch {",
    "      throw new TypeError(\"Toolchain baseUrl must be absolute or root-relative.\");",
    "    }",
    "  }",
    "  if (url.protocol !== \"http:\" && url.protocol !== \"https:\") {",
    "    throw new TypeError(\"Toolchain baseUrl must use HTTP or HTTPS.\");",
    "  }",
    "  if (url.username || url.password) throw new TypeError(\"Toolchain baseUrl must not contain credentials.\");",
    "  if (!url.pathname.endsWith(\"/\")) url.pathname += \"/\";",
    "  if (value.startsWith(\"/\")) return `${url.pathname}${url.search}`;",
    "  return url.href;",
    "}",
    "",
    "function deepFreeze(value) {",
    "  if (value && typeof value === \"object\") {",
    "    for (const nested of Object.values(value)) deepFreeze(nested);",
    "    Object.freeze(value);",
    "  }",
    "  return value;",
    "}",
    "",
  ].join("\n");
}

function toolchainDeclaration(descriptor) {
  return [
    'import type { BrowserToolchainSource, ServerToolchainSource, ToolchainDescriptor } from "@wasm-oj/contracts";',
    "",
    `export declare const descriptor: ToolchainDescriptor & { readonly id: ${JSON.stringify(descriptor.id)}; readonly version: ${JSON.stringify(descriptor.version)} };`,
    "export declare function browserSource(baseUrl: string): BrowserToolchainSource;",
    "export declare function serverSource(): ServerToolchainSource;",
    "",
  ].join("\n");
}

async function copyCommonFiles(packageRoot, licenses) {
  await Promise.all([
    rm(path.join(packageRoot, "licenses"), { recursive: true, force: true }),
    rm(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), { force: true }),
  ]);
  await Promise.all([
    copyFile(path.join(repositoryRoot, "LICENSE"), path.join(packageRoot, "LICENSE")),
    ...(licenses.length > 0 ? [
      copyFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), path.join(packageRoot, "THIRD_PARTY_NOTICES.md")),
      mkdir(path.join(packageRoot, "licenses"), { recursive: true }).then(() => Promise.all(
        licenses.map((filename) => copyFile(
          path.join(repositoryRoot, "licenses", filename),
          path.join(packageRoot, "licenses", filename),
        )),
      )),
    ] : []),
  ]);
}

async function copyServerRuntimeSources(packageRoot) {
  const sourcePairs = [
    ["rust-toolchain.toml", "rust-toolchain.toml"],
    ["crates/runtime-core", "crates/runtime-core"],
    ["vendor/shared-buffer", "vendor/shared-buffer"],
    ["vendor/virtual-fs", "vendor/virtual-fs"],
    ["testdata/wojjdg02-v2-text.hex", "testdata/wojjdg02-v2-text.hex"],
  ];
  for (const [source, target] of sourcePairs) {
    const destination = path.join(packageRoot, target);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, source), destination, {
      recursive: true,
      filter: (entry) => !entry.split(path.sep).includes("target"),
    });
  }
}

async function replaceDirectory(staging, destination) {
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
}

async function verifyEmittedDeclarationInputs(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await verifyEmittedDeclarationInputs(absolute, relative);
    else if (entry.isFile() && /\.d\.(?:c|m)?ts$/u.test(entry.name)) {
      const source = await readFile(absolute, "utf8");
      if (source.includes("@/")) {
        throw new Error(`Declaration input '${relative}' contains a repository source alias.`);
      }
    }
  }
}

async function verifyDeclarationBoundary(stagingDir, definition) {
  const declarations = (await collectDeclarations(stagingDir)).sort();
  const expected = ["index.d.ts"];
  if (definition.sdk) expected.push("browser.d.ts", "contracts.d.ts", "organizer.d.ts", "server.d.ts");
  expected.sort();
  if (JSON.stringify(declarations) !== JSON.stringify(expected)) {
    throw new Error(`${definition.name} declarations differ: expected ${expected.join(", ")}; received ${declarations.join(", ") || "none"}.`);
  }
  for (const relative of declarations) {
    const source = await readFile(path.join(stagingDir, relative), "utf8");
    if (source.includes("@/") || /\b(?:from|import)\s*\(?\s*["']\.\.?\//u.test(source)) {
      throw new Error(`Rolled declaration '${relative}' leaks an internal module specifier.`);
    }
  }
}

async function collectDeclarations(directory, prefix = "") {
  const declarations = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) declarations.push(...await collectDeclarations(path.join(directory, entry.name), relative));
    else if (entry.isFile() && /\.d\.(?:c|m)?ts$/u.test(entry.name)) declarations.push(relative);
  }
  return declarations;
}
