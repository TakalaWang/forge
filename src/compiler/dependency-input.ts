import type { Project, ProjectFile } from "../core/types.ts";
import type { DependencyEcosystem } from "../dependencies/types.ts";
import type { MaterializedDependencyPackage } from "../dependencies/build.ts";

const ECOSYSTEM_BY_LANGUAGE: Readonly<Record<string, DependencyEcosystem>> = Object.freeze({
  c: "cpp",
  cpp: "cpp",
  rust: "cargo",
  python: "pypi",
  javascript: "npm",
  typescript: "npm",
  go: "go",
});

export interface CppDependencyInput {
  files: ReadonlyMap<string, Uint8Array>;
  includeDirectories: readonly string[];
  sources: readonly string[];
}

export interface RustDependencyCrate {
  id: string;
  crateName: string;
  root: string;
  edition: string;
  outputPath: string;
  features: readonly string[];
  externs: readonly { crateName: string; path: string }[];
}

export interface RustDependencyInput {
  files: ProjectFile[];
  crates: readonly RustDependencyCrate[];
  roots: readonly { crateName: string; path: string }[];
}

export interface GoDependencyPackage {
  id: string;
  importPath: string;
  sourcePaths: readonly string[];
  imports: readonly string[];
  archivePath: string;
}

export interface GoDependencyInput {
  files: ProjectFile[];
  packages: readonly GoDependencyPackage[];
}

export function assertProjectDependencyEcosystem(project: Project): void {
  if (!project.dependencies) return;
  const expected = ECOSYSTEM_BY_LANGUAGE[project.config.language];
  if (!expected) throw new Error(`Compiler '${project.config.language}' does not declare a dependency ecosystem.`);
  const mismatch = project.dependencies.packages.find((item) => item.package.ecosystem !== expected);
  if (mismatch) {
    throw new Error(
      `${project.config.language} projects accept only '${expected}' dependencies; '${mismatch.package.id}' is '${mismatch.package.ecosystem}'.`,
    );
  }
}

export function projectDependencyPackages(
  project: Project,
  ecosystem: DependencyEcosystem,
): readonly MaterializedDependencyPackage[] {
  assertProjectDependencyEcosystem(project);
  return project.dependencies?.packages.filter((item) => item.package.ecosystem === ecosystem) ?? [];
}

export function pythonDependencyFiles(project: Project): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const item of projectDependencyPackages(project, "pypi")) {
    for (const [path, bytes] of Object.entries(item.files)) {
      files[`site-packages/${path}`] = bytes.slice();
    }
  }
  return files;
}

export function npmDependencyFiles(project: Project): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {};
  const names = new Set<string>();
  const untyped: string[] = [];
  for (const item of projectDependencyPackages(project, "npm")) {
    if (names.has(item.package.name)) {
      throw new Error(`npm dependency '${item.package.name}' resolves to multiple versions in a flat runtime graph.`);
    }
    names.add(item.package.name);
    const manifestBytes = item.files["package.json"];
    if (!manifestBytes) throw new Error(`npm dependency '${item.package.id}' omits package.json.`);
    const manifestText = decodeDependencyText(manifestBytes, item.package.id, "package.json");
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    if (manifest.type === "module") {
      throw new Error(`npm dependency '${item.package.id}' uses unsupported ESM package semantics.`);
    }
    if (!Object.keys(item.files).some((path) => path.endsWith(".d.ts"))) untyped.push(item.package.name);
    for (const [path, bytes] of Object.entries(item.files)) {
      const installedPath = `node_modules/${item.package.name}/${path}`;
      files[installedPath] = isNpmTextPath(path)
        ? decodeDependencyText(bytes, item.package.id, path)
        : bytes.slice();
    }
  }
  if (untyped.length > 0) {
    files[".wasm-oj/npm-untyped-modules.d.ts"] = untyped.sort().flatMap((name) => [
      `declare module ${JSON.stringify(name)} { const value: any; export = value; }`,
      `declare module ${JSON.stringify(`${name}/*`)} { const value: any; export = value; }`,
    ]).join("\n");
  }
  return files;
}

export function cppDependencyInput(project: Project): CppDependencyInput {
  const files = new Map<string, Uint8Array>();
  const includeDirectories: string[] = [];
  const sources: string[] = [];
  for (const [index, item] of projectDependencyPackages(project, "cpp").entries()) {
    const root = `.wasm-oj/dependencies/cpp/${String(index).padStart(4, "0")}`;
    includeDirectories.push(`/project/${root}`);
    if (Object.keys(item.files).some((path) => path.startsWith("include/"))) {
      includeDirectories.push(`/project/${root}/include`);
    }
    for (const [path, bytes] of Object.entries(item.files)) {
      if (!isCppCompilerPath(path)) continue;
      decodeDependencyText(bytes, item.package.id, path);
      const installedPath = `${root}/${path}`;
      files.set(installedPath, bytes.slice());
      if (isCppSourcePath(path)) {
        if (project.config.language === "c" && !path.endsWith(".c")) {
          throw new Error(`C dependency '${item.package.id}' contains C++ source '${path}'.`);
        }
        sources.push(installedPath);
      }
    }
  }
  return {
    files,
    includeDirectories: Object.freeze(includeDirectories),
    sources: Object.freeze(sources),
  };
}

export function rustDependencyInput(project: Project): RustDependencyInput {
  const packages = projectDependencyPackages(project, "cargo");
  const packageById = new Map(packages.map((item) => [item.package.id, item]));
  const ordered = topologicalPackages(packages);
  const descriptorById = new Map<string, Omit<RustDependencyCrate, "externs">>();
  const files: ProjectFile[] = [];
  for (const [index, item] of ordered.entries()) {
    const prefix = `.wasm-oj/dependencies/cargo/${String(index).padStart(4, "0")}`;
    const manifestBytes = item.files["Cargo.toml"]!;
    const manifest = decodeDependencyText(manifestBytes, item.package.id, "Cargo.toml");
    if (/\bpackage\s*=\s*"/m.test(dependencySections(manifest))) {
      throw new Error(`Cargo dependency '${item.package.id}' uses unsupported renamed dependencies.`);
    }
    const libSection = tomlSection(manifest, "lib");
    const crateName = rustIdentifier(tomlString(libSection, "name") ?? item.package.name, item.package.id);
    const rootRelative = tomlString(libSection, "path") ?? "src/lib.rs";
    if (!item.files[rootRelative]) throw new Error(`Cargo dependency '${item.package.id}' omits '${rootRelative}'.`);
    const edition = tomlString(tomlSection(manifest, "package"), "edition") ?? "2015";
    if (!/^(?:2015|2018|2021|2024)$/.test(edition)) {
      throw new Error(`Cargo dependency '${item.package.id}' has unsupported Rust edition '${edition}'.`);
    }
    const outputPath = `/workspace/build/deps/lib${String(index).padStart(4, "0")}_${crateName}.rlib`;
    descriptorById.set(item.package.id, {
      id: item.package.id,
      crateName,
      root: `${prefix}/${rootRelative}`,
      edition,
      outputPath,
      features: Object.freeze([...(item.package.features ?? [])]),
    });
    for (const [path, bytes] of Object.entries(item.files)) {
      if (!isCargoCompilerText(path)) continue;
      files.push({
        path: `${prefix}/${path}`,
        language: "rust",
        content: decodeDependencyText(bytes, item.package.id, path),
      });
    }
  }
  const crates = ordered.map((item): RustDependencyCrate => {
    const descriptor = descriptorById.get(item.package.id)!;
    return Object.freeze({
      ...descriptor,
      externs: Object.freeze(item.package.dependencies.map((id) => {
        const dependency = descriptorById.get(id);
        if (!dependency) throw new Error(`Cargo dependency '${item.package.id}' refers to unavailable '${id}'.`);
        return Object.freeze({ crateName: dependency.crateName, path: dependency.outputPath });
      })),
    });
  });
  const roots = project.dependencies?.lock.roots.map((id) => {
    if (!packageById.has(id)) throw new Error(`Cargo root '${id}' is unavailable.`);
    const descriptor = descriptorById.get(id)!;
    return Object.freeze({ crateName: descriptor.crateName, path: descriptor.outputPath });
  }) ?? [];
  return { files, crates: Object.freeze(crates), roots: Object.freeze(roots) };
}

export function goDependencyInput(project: Project): GoDependencyInput {
  const files: ProjectFile[] = [];
  const packages: GoDependencyPackage[] = [];
  for (const [moduleIndex, item] of projectDependencyPackages(project, "go").entries()) {
    const moduleRoot = `.wasm-oj/dependencies/go/${String(moduleIndex).padStart(4, "0")}`;
    const directories = new Map<string, Array<{ path: string; content: string }>>();
    for (const [path, bytes] of Object.entries(item.files)) {
      if (!path.endsWith(".go") || path.endsWith("_test.go") || path.split("/").includes("vendor")) continue;
      const content = decodeDependencyText(bytes, item.package.id, path);
      if (/^\s*\/\/(?:go:build|\s*\+build)\b/m.test(content)) {
        throw new Error(`Go dependency '${item.package.id}' uses unsupported build constraints in '${path}'.`);
      }
      if (/import\s+(?:[._A-Za-z][A-Za-z0-9_]*\s+)?["`]C["`]/.test(content)) {
        throw new Error(`Go dependency '${item.package.id}' uses unsupported cgo in '${path}'.`);
      }
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const group = directories.get(directory) ?? [];
      group.push({ path, content });
      directories.set(directory, group);
      files.push({ path: `${moduleRoot}/${path}`, language: "go", content });
    }
    for (const [directory, sourceFiles] of [...directories].sort(([left], [right]) => left.localeCompare(right))) {
      const packageNames = new Set(sourceFiles.map((file) => goPackageName(file.content, item.package.id, file.path)));
      if (packageNames.size !== 1) {
        throw new Error(`Go dependency '${item.package.id}' directory '${directory || "."}' contains multiple packages.`);
      }
      if ([...packageNames][0] === "main") continue;
      const importPath = directory ? `${item.package.name}/${directory}` : item.package.name;
      const index = packages.length;
      packages.push(Object.freeze({
        id: `${item.package.id}:${directory || "."}`,
        importPath,
        sourcePaths: Object.freeze(sourceFiles.map((file) => `${moduleRoot}/${file.path}`).sort()),
        imports: Object.freeze([...new Set(sourceFiles.flatMap((file) => goImports(file.content)))].sort()),
        archivePath: `/work/build/deps/${String(index).padStart(4, "0")}.a`,
      }));
    }
  }
  return { files, packages: Object.freeze(packages) };
}

function decodeDependencyText(bytes: Uint8Array, id: string, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Dependency '${id}' compiler file '${path}' is not valid UTF-8.`, { cause: error });
  }
}

function isNpmTextPath(path: string): boolean {
  return /(?:^|\/)(?:package\.json)$/.test(path) || /\.(?:js|cjs|d\.ts|json)$/i.test(path);
}

function isCppCompilerPath(path: string): boolean {
  return /\.(?:h|hh|hpp|hxx|inc|c|cc|cpp|cxx)$/i.test(path);
}

function isCppSourcePath(path: string): boolean {
  return /\.(?:c|cc|cpp|cxx)$/i.test(path);
}

function topologicalPackages(packages: readonly MaterializedDependencyPackage[]): MaterializedDependencyPackage[] {
  const byId = new Map(packages.map((item) => [item.package.id, item]));
  const state = new Map<string, "visiting" | "visited">();
  const ordered: MaterializedDependencyPackage[] = [];
  const visit = (id: string) => {
    const current = state.get(id);
    if (current === "visited") return;
    if (current === "visiting") throw new Error(`Dependency graph contains a cycle at '${id}'.`);
    const item = byId.get(id);
    if (!item) throw new Error(`Dependency graph refers to unavailable package '${id}'.`);
    state.set(id, "visiting");
    for (const dependency of item.package.dependencies) visit(dependency);
    state.set(id, "visited");
    ordered.push(item);
  };
  for (const item of packages) visit(item.package.id);
  return ordered;
}

function tomlSection(manifest: string, name: string): string {
  const match = manifest.match(new RegExp(`(?:^|\\n)\\[${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`));
  return match?.[1] ?? "";
}

function tomlString(section: string, key: string): string | undefined {
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?$`, "m"));
  return match?.[1];
}

function dependencySections(manifest: string): string {
  return manifest.split(/\n(?=\[)/).filter((section) => /\bdependencies\]/.test(section.split("\n", 1)[0]!)).join("\n");
}

function rustIdentifier(name: string, id: string): string {
  const normalized = name.replaceAll("-", "_");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Cargo dependency '${id}' has unsupported crate name '${name}'.`);
  }
  return normalized;
}

function isCargoCompilerText(path: string): boolean {
  return path.endsWith(".rs") || path.endsWith(".md") || path.endsWith(".txt") || path === "Cargo.toml";
}

function goPackageName(source: string, id: string, path: string): string {
  const match = source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/m);
  if (!match) throw new Error(`Go dependency '${id}' source '${path}' has no package declaration.`);
  return match[1]!;
}

export function goImports(source: string): string[] {
  const imports: string[] = [];
  const blockPattern = /\bimport\s*\(([\s\S]*?)\)/g;
  for (const block of source.matchAll(blockPattern)) {
    for (const match of block[1]!.matchAll(/(?:^|\n)\s*(?:[._A-Za-z][A-Za-z0-9_]*\s+)?["`]([^"`]+)["`]/g)) {
      imports.push(match[1]!);
    }
  }
  const withoutBlocks = source.replace(blockPattern, "");
  for (const match of withoutBlocks.matchAll(/\bimport\s+(?:[._A-Za-z][A-Za-z0-9_]*\s+)?["`]([^"`]+)["`]/g)) {
    imports.push(match[1]!);
  }
  return imports;
}
