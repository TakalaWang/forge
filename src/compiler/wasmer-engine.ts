import type { Package, Wasmer } from "@wasmer/sdk";
import { WASM_OJ_CONTRACT_VERSION } from "../core/contract.ts";
import {
  canonicalRuntimeBundleFiles,
  createRuntimeBundleManifest,
} from "../core/artifact-validation.ts";
import { canonicalProjectFiles } from "../core/project-files.ts";
import { costProfileId } from "../core/cost-profile.ts";
import { ensureFailureDiagnostic, parseTypeScriptDiagnostics } from "../core/diagnostics.ts";
import { QUICKJS_COMMONJS_DECLARATION, QUICKJS_NODE_MODULE_DECLARATION, QUICKJS_STD_MODULE_DECLARATION } from "../core/quickjs-runtime.ts";
import {
  PYTHON_PACKAGE,
  GO_VERSION,
  QUICKJS_PACKAGE,
  RUST_VERSION,
  TYPESCRIPT_ASSET_PATH,
  TYPESCRIPT_VERSION,
  toolchainContentIdentity,
  toolchainPackageIdentities,
} from "../core/toolchains.ts";
import { LanguageDriverRegistry } from "./language-driver.ts";
import type {
  BuildResult,
  CompilerTraceEvent,
  CompilerTraceOperation,
  Project,
  ProjectFile,
  RuntimeBundleArtifact,
  WasmArtifact,
  WorkerPhase,
} from "../core/types.ts";
import {
  PYTHON_DETERMINISTIC_RUNNER,
  PYTHON_RUNNER_PATH,
} from "../runtime/determinism.ts";
import type {
  RustCompileRequest,
  RustCompileResult,
} from "./rust-toolchain.ts";
import type { GoCompileRequest, GoCompileResult } from "./go-toolchain.ts";
import type { JavaCompileRequest, JavaCompileResult } from "./java-toolchain.ts";
import { buildClangWithSdkDirect } from "./sdk-direct-clang.ts";
import { runSandboxCommand } from "./sandbox-command.ts";
import {
  assertProjectDependencyEcosystem,
  goDependencyInput,
  npmDependencyFiles,
  pythonDependencyFiles,
  rustDependencyInput,
} from "./dependency-input.ts";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let typescriptCompilerBytes: Promise<Uint8Array> | undefined;
let typescriptCompiler: { wasmer: Wasmer; pkg: Promise<Package> } | undefined;

export interface WasmerCompilerHost {
  getWasmer(): Wasmer;
  loadToolchainAsset(path: string): Promise<Uint8Array>;
  loadToolchainFile(path: string): Promise<Uint8Array>;
  compileRust(request: RustCompileRequest): Promise<RustCompileResult>;
  compileGo(request: GoCompileRequest): Promise<GoCompileResult>;
  compileJava(request: JavaCompileRequest): Promise<JavaCompileResult>;
  progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void;
  trace(requestId: string, operation: CompilerTraceOperation, state: CompilerTraceEvent["state"]): void;
}

let host: WasmerCompilerHost | undefined;

export function configureWasmerCompilerHost(nextHost: WasmerCompilerHost): void {
  host = nextHost;
}

function progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void {
  requireHost().progress(requestId, phase, label, value);
}

function requireHost(): WasmerCompilerHost {
  if (!host) throw new Error("Wasmer compiler host is not configured.");
  return host;
}

async function getTypeScriptCompiler(): Promise<Package> {
  const wasmer = requireHost().getWasmer();
  if (typescriptCompiler?.wasmer !== wasmer) {
    typescriptCompilerBytes ??= requireHost().loadToolchainAsset(TYPESCRIPT_ASSET_PATH);
    const bytes = typescriptCompilerBytes;
    typescriptCompiler = { wasmer, pkg: bytes.then((value) => wasmer.packages.load(value)) };
  }
  const pending = typescriptCompiler;
  try {
    return await pending.pkg;
  } catch (error) {
    if (typescriptCompiler === pending) {
      typescriptCompiler = undefined;
      typescriptCompilerBytes = undefined;
    }
    throw error;
  }
}

function createArtifactBase(project: Project, cacheKey: string, started: number, size: number, toolchains: string[], contentIdentity?: string) {
  return {
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    id: crypto.randomUUID(),
    projectId: project.id,
    cacheKey,
    name: `${project.name}.${project.config.target === "wasip1" ? "wasm" : "wasix.wasm"}`,
    language: project.config.language,
    target: project.config.target,
    optimization: project.config.optimization,
    createdAt: Date.now(),
    durationMs: performance.now() - started,
    size,
    toolchains,
    costProfile: costProfileId(
      project.config.language,
      project.config.target,
      project.config.optimization,
      contentIdentity,
    ),
    ...(project.dependencies === undefined ? {} : { dependencyLockSha256: project.dependencies.lockSha256 }),
  } as const;
}

async function buildRust(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  progress(requestId, "compiling", `Compiling with rustc ${RUST_VERSION}`, 0.2);
  const dependencies = rustDependencyInput(project);
  const compiled = await requireHost().compileRust({
    entry: project.config.entry,
    files: [...project.files, ...dependencies.files],
    optimization: project.config.optimization,
    dependencies: dependencies.crates,
    rootExterns: dependencies.roots,
  });
  if (!compiled.success || !compiled.wasm) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(compiled.diagnostics, {
        file: project.config.entry,
        source: "rustc",
        message: compiled.stderr.trim() || "rustc failed without a diagnostic.",
      }),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      cacheHit: false,
    };
  }

  const bytes = compiled.wasm;
  const artifact: WasmArtifact = {
    kind: "wasm",
    ...createArtifactBase(project, cacheKey, started, bytes.byteLength, toolchainPackageIdentities("rust")),
    bytes,
  };
  return {
    success: true,
    diagnostics: compiled.diagnostics,
    artifact,
    stdout: compiled.stdout,
    stderr: compiled.stderr,
    cacheHit: false,
  };
}

function sumFileSize(files: Record<string, string | Uint8Array>): number {
  return Object.values(files).reduce((total, file) => total + (typeof file === "string" ? encoder.encode(file).byteLength : file.byteLength), 0);
}

async function buildPython(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  const dependencies = pythonDependencyFiles(project);
  progress(requestId, "compiling", "Packaging Python sources", 0.55);
  const files: Record<string, string | Uint8Array> = Object.fromEntries(project.files.map((file) => [file.path, file.content]));
  Object.assign(files, dependencies);
  files[PYTHON_RUNNER_PATH] = PYTHON_DETERMINISTIC_RUNNER;
  const entry = project.config.entry;
  const manifest = createRuntimeBundleManifest(project, PYTHON_PACKAGE, "python", entry);
  files["wasm-oj.manifest.json"] = manifest;
  const bundleFiles = canonicalRuntimeBundleFiles(files);
  const size = sumFileSize(bundleFiles);
  const artifact: RuntimeBundleArtifact = {
    kind: "runtime-bundle",
    ...createArtifactBase(project, cacheKey, started, size, toolchainPackageIdentities("python")),
    name: `${project.name}.python-${project.config.target}.json`,
    runtimePackage: PYTHON_PACKAGE,
    command: "python",
    entry,
    files: bundleFiles,
    manifest,
  };
  return { success: true, diagnostics: [], artifact, stdout: "", stderr: "", cacheHit: false };
}

async function buildGo(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  progress(requestId, "compiling", `Compiling with Go ${GO_VERSION}`, 0.3);
  const dependencies = goDependencyInput(project);
  const compiled = await requireHost().compileGo({
    entry: project.config.entry,
    files: project.files,
    dependencyFiles: dependencies.files,
    optimization: project.config.optimization,
    dependencies: dependencies.packages,
  });
  if (!compiled.success || !compiled.wasm) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(compiled.diagnostics, {
        file: project.config.entry,
        source: "go",
        message: compiled.stderr.trim() || "Go compilation failed without a diagnostic.",
      }),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      cacheHit: false,
    };
  }
  const artifact: WasmArtifact = {
    kind: "wasm",
    ...createArtifactBase(project, cacheKey, started, compiled.wasm.byteLength, toolchainPackageIdentities("go")),
    bytes: compiled.wasm,
  };
  return {
    success: true,
    diagnostics: compiled.diagnostics,
    artifact,
    stdout: compiled.stdout,
    stderr: compiled.stderr,
    cacheHit: false,
  };
}

async function buildJava(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  const entry = project.files.find((file) => file.path === project.config.entry);
  if (!entry || !entry.path.endsWith(".java")) {
    return {
      success: false,
      diagnostics: [{
        severity: "error",
        message: "The Java entry must be a .java source file.",
        file: project.config.entry,
        line: 1,
        column: 1,
        source: "project",
      }],
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
  }
  progress(requestId, "compiling", `Compiling Java ${entry.path}`, 0.3);
  const compiled = await requireHost().compileJava({
    entry: project.config.entry,
    files: project.files,
    optimization: project.config.optimization,
  });
  if (!compiled.success || !compiled.wasm) {
    return {
      success: false,
      diagnostics: ensureFailureDiagnostic(compiled.diagnostics, {
        file: project.config.entry,
        source: "java",
        message: compiled.stderr.trim() || "Java compilation failed without a diagnostic.",
      }),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      cacheHit: false,
    };
  }
  const artifact: WasmArtifact = {
    kind: "wasm",
    ...createArtifactBase(
      project,
      cacheKey,
      started,
      compiled.wasm.byteLength,
      toolchainPackageIdentities("java"),
      toolchainContentIdentity("java"),
    ),
    bytes: compiled.wasm,
  };
  return {
    success: true,
    diagnostics: compiled.diagnostics,
    artifact,
    stdout: compiled.stdout,
    stderr: compiled.stderr,
    cacheHit: false,
  };
}

function emittedScriptPath(path: string): string {
  if (path.endsWith(".ts")) return path.slice(0, -3) + ".js";
  return path;
}

function scriptSourceFiles(project: Project): ProjectFile[] {
  const extension = project.config.language === "typescript" ? ".ts" : ".js";
  return project.files.filter((file) => file.path.endsWith(extension));
}

function emittedSourceFiles(project: Project): ProjectFile[] {
  return scriptSourceFiles(project).filter((file) => !file.path.endsWith(".d.ts"));
}

interface TypeScriptWasiResponse {
  status: number;
  diagnostics: string;
  files: Record<string, string>;
}

interface TypeScriptWasiOutput {
  ok: boolean;
  stderr: string;
}

async function transpileScriptProject(project: Project, requestId: string): Promise<{ files: Record<string, string | Uint8Array>; output: TypeScriptWasiOutput; response?: TypeScriptWasiResponse }> {
  const scriptFiles = scriptSourceFiles(project);
  const emittedFiles = emittedSourceFiles(project);
  const dependencyFiles = npmDependencyFiles(project);
  progress(requestId, "loading-toolchain", `Loading TypeScript ${TYPESCRIPT_VERSION}/WASI`);
  const compiler = await getTypeScriptCompiler();
  if (!compiler.entrypoint) throw new Error("The TypeScript/WASI compiler has no executable entrypoint.");
  const outputPaths = emittedFiles.map((file) => emittedScriptPath(file.path));
  const declarationPath = "/project/.wasm-oj/quickjs.d.ts";
  const sandbox = await requireHost().getWasmer().sandboxes.create({ packages: [compiler] });
  const completed = await runSandboxCommand(sandbox, { abandoned: false }, {
    command: compiler,
    args: [],
    stdin: JSON.stringify({
      files: {
        ...Object.fromEntries(project.files.map((file) => [`/project/${file.path}`, file.content])),
        ...Object.fromEntries(Object.entries(dependencyFiles)
          .filter(([, contents]) => typeof contents === "string")
          .map(([path, contents]) => [`/project/${path}`, contents])),
        [declarationPath]: QUICKJS_STD_MODULE_DECLARATION + QUICKJS_NODE_MODULE_DECLARATION
          + QUICKJS_COMMONJS_DECLARATION,
      },
      sources: [
        declarationPath,
        ...scriptFiles.map((file) => `/project/${file.path}`),
        ...Object.entries(dependencyFiles)
          .filter(([path, contents]) => path.endsWith(".d.ts") && typeof contents === "string")
          .map(([path]) => `/project/${path}`),
      ],
      outputs: outputPaths.map((path) => `/project/build/${path}`),
    }),
  });
  await sandbox.close();
  const output = { ok: completed.ok, stderr: decoder.decode(completed.stderr) };
  let response: TypeScriptWasiResponse | undefined;
  if (output.ok) {
    try {
      response = JSON.parse(decoder.decode(completed.stdout)) as TypeScriptWasiResponse;
    } catch {
      response = undefined;
    }
  }
  const files: Record<string, string | Uint8Array> = {};
  if (response) {
    for (const outputPath of outputPaths) {
      const contents = response.files[`/project/build/${outputPath}`];
      if (contents !== undefined) files[outputPath] = contents;
    }
  }
  Object.assign(files, dependencyFiles);
  return { files, output, response };
}

async function buildScript(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const started = performance.now();
  if (!emittedSourceFiles(project).some((file) => file.path === project.config.entry)) {
    return {
      success: false,
      diagnostics: [{
        severity: "error",
        message: `The ${project.config.language === "typescript" ? ".ts" : ".js"} entry file is not a supported executable source.`,
        file: project.config.entry,
        line: 1,
        column: 1,
        source: "project",
      }],
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
  }
  let files: Record<string, string | Uint8Array>;
  let diagnostics: BuildResult["diagnostics"] = [];
  let stderr = "";
  if (project.config.language === "javascript") {
    progress(requestId, "compiling", "Preparing JavaScript modules", 0.5);
    files = {
      ...Object.fromEntries(emittedSourceFiles(project).map(file => [file.path, file.content])),
      ...npmDependencyFiles(project),
    };
  } else {
    progress(requestId, "compiling", "Compiling TypeScript with TypeScript/WASI", 0.5);
    const transpiled = await transpileScriptProject(project, requestId);
    files = transpiled.files;
    stderr = transpiled.output.stderr;
    diagnostics = parseTypeScriptDiagnostics(transpiled.response?.diagnostics ?? "");
    const emittedOutputsPresent = emittedSourceFiles(project)
      .every((file) => Object.hasOwn(files, emittedScriptPath(file.path)));
    if (!transpiled.output.ok || !transpiled.response || transpiled.response.status !== 0 || !emittedOutputsPresent || diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return {
        success: false,
        diagnostics: ensureFailureDiagnostic(diagnostics, {
          file: project.config.entry,
          source: "typescript",
          message: stderr.trim() || transpiled.response?.diagnostics.trim() || `TypeScript ${TYPESCRIPT_VERSION} did not return every compiled output.`,
        }),
        stdout: "",
        stderr,
        cacheHit: false,
      };
    }
  }
  const entry = emittedScriptPath(project.config.entry);
  const manifest = createRuntimeBundleManifest(project, QUICKJS_PACKAGE, "qjs", entry);
  files["wasm-oj.manifest.json"] = manifest;
  const bundleFiles = canonicalRuntimeBundleFiles(files);
  const size = sumFileSize(bundleFiles);
  const artifact: RuntimeBundleArtifact = {
    kind: "runtime-bundle",
    ...createArtifactBase(project, cacheKey, started, size, toolchainPackageIdentities(project.config.language)),
    name: `${project.name}.${project.config.language === "typescript" ? "typescript" : "javascript"}-${project.config.target}.json`,
    runtimePackage: QUICKJS_PACKAGE,
    command: "qjs",
    entry,
    files: bundleFiles,
    manifest,
  };
  return { success: true, diagnostics, artifact, stdout: "", stderr, cacheHit: false };
}

export async function buildProject(project: Project, cacheKey: string, requestId: string): Promise<BuildResult> {
  const canonicalProject = { ...project, files: canonicalProjectFiles(project.files) };
  assertProjectDependencyEcosystem(canonicalProject);
  progress(requestId, "checking", "Validating project configuration", 0.05);
  if (!canonicalProject.files.some((file) => file.path === canonicalProject.config.entry)) {
    return {
      success: false,
      diagnostics: [{ severity: "error", message: "Configured entry file does not exist.", file: canonicalProject.config.entry, line: 1, column: 1, source: "project" }],
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
  }
  if (canonicalProject.config.language === "c" || canonicalProject.config.language === "cpp") {
    const activeHost = requireHost();
    return buildClangWithSdkDirect(canonicalProject, cacheKey, requestId, {
      wasmer: activeHost.getWasmer(),
      loadToolchainAsset: activeHost.loadToolchainAsset,
      loadToolchainFile: activeHost.loadToolchainFile,
      progress: activeHost.progress,
      trace: activeHost.trace,
    });
  }
  return languageDrivers.driver(canonicalProject.config.language).build({ project: canonicalProject, cacheKey, requestId });
}

const languageDrivers = new LanguageDriverRegistry();
languageDrivers.register({
  id: "rustc",
  languages: ["rust"],
  build: ({ project, cacheKey, requestId }) => buildRust(project, cacheKey, requestId),
});
languageDrivers.register({
  id: "cpython",
  languages: ["python"],
  build: ({ project, cacheKey, requestId }) => buildPython(project, cacheKey, requestId),
});
languageDrivers.register({
  id: "typescript",
  languages: ["javascript", "typescript"],
  build: ({ project, cacheKey, requestId }) => buildScript(project, cacheKey, requestId),
});
languageDrivers.register({
  id: "go",
  languages: ["go"],
  build: ({ project, cacheKey, requestId }) => buildGo(project, cacheKey, requestId),
});
languageDrivers.register({
  id: "teavm-java",
  languages: ["java"],
  build: ({ project, cacheKey, requestId }) => buildJava(project, cacheKey, requestId),
});

export function clearCompilerHostCaches(): void {
  typescriptCompilerBytes = undefined;
  typescriptCompiler = undefined;
}
