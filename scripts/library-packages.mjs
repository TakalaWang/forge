import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const packagesRoot = path.join(repositoryRoot, "packages");
export const CODE_VERSION = "0.2.3";
export const TOOLCHAIN_DESCRIPTOR_SCHEMA = "wasm-oj-v2/toolchain-package";
export const WASM_OJ_CONTRACT_VERSION = 2;

const code = (directory, source, extra = {}) => Object.freeze({
  kind: "code",
  name: `@wasm-oj/${directory}`,
  directory,
  source,
  ...extra,
});

export const CODE_PACKAGES = Object.freeze([
  code("contracts", "src/sdk/contracts.ts", {
    licenses: [],
    runtimeDependencies: [],
  }),
  code("core", "src/sdk/core.ts", {
    licenses: ["fflate-MIT.txt", "quickjs-node-stdlib-LICENSES.txt"],
    runtimeDependencies: ["@wasm-oj/contracts", "fflate"],
  }),
  code("browser", "src/sdk/browser.ts", {
    browser: true,
    licenses: [
      "quickjs-node-stdlib-LICENSES.txt",
      "es-module-lexer-MIT.txt",
      "fflate-MIT.txt",
      "wasmer-sdk-LICENSE.txt",
      "wasmer-sdk-acorn-MIT.txt",
      "wasmer-sdk-dependencies.html",
      "wasmer-sdk-dependencies.json",
      "runtime-core-dependencies.html",
      "runtime-core-dependencies.json",
    ],
    runtimeDependencies: [
      "@wasm-oj/contracts",
      "@wasm-oj/core",
      "es-module-lexer",
      "fflate",
    ],
  }),
  code("server", "src/server/index.ts", {
    server: true,
    licenses: [
      "quickjs-node-stdlib-LICENSES.txt",
      "fflate-MIT.txt",
      "wasmer-sdk-LICENSE.txt",
      "wasmer-sdk-dependencies.html",
      "wasmer-sdk-dependencies.json",
      "runtime-core-dependencies.html",
      "runtime-core-dependencies.json",
    ],
    runtimeDependencies: ["@wasm-oj/contracts", "@wasm-oj/core", "@wasmer/sdk", "fflate"],
  }),
  code("organizer", "src/sdk/organizer.ts", {
    organizer: true,
    licenses: ["fflate-MIT.txt"],
    runtimeDependencies: ["@wasm-oj/core"],
  }),
  code("cli", "src/cli/index.ts", {
    cli: true,
    licenses: ["napi-rs-keyring-MIT.txt"],
    runtimeDependencies: [
      "@napi-rs/keyring",
      "@wasm-oj/core",
      "@wasm-oj/organizer",
      "@wasm-oj/server",
    ],
  }),
  code("sdk", "packages/sdk/src/index.ts", {
    sdk: true,
    licenses: [],
    runtimeDependencies: [
      "@wasm-oj/browser",
      "@wasm-oj/contracts",
      "@wasm-oj/core",
      "@wasm-oj/organizer",
      "@wasm-oj/server",
    ],
  }),
]);

const optimizations = Object.freeze(["debug", "release"]);
const profiles = (languages, targets) => Object.freeze(languages.flatMap((language) => (
  targets.flatMap((target) => optimizations.map((optimization) => Object.freeze({
    language,
    target,
    optimization,
  })))
)));

const toolchain = (directory, definition) => Object.freeze({
  kind: "toolchain",
  name: `@wasm-oj/${directory}`,
  directory,
  ...definition,
  languages: Object.freeze([...definition.languages]),
  profiles: profiles(definition.languages, definition.targets),
  assets: Object.freeze([...definition.assets]),
  licenses: Object.freeze([...definition.licenses]),
});

export const TOOLCHAIN_PACKAGES = Object.freeze([
  toolchain("toolchain-clang", {
    id: "clang",
    toolchainVersion: "22.0.0-git20542-10",
    languages: ["c", "cpp"],
    targets: ["wasip1", "wasix"],
    assets: [
      "clang-22.0.0-git20542-10.cc1-pins.json",
      "clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin",
      "clang-22.0.0-git20542-10.cpp-release.pch.gz.bin",
      "clang-22.0.0-git20542-10.libcxx-pch.json",
      "clang-22.0.0-git20542-10.manifest.json",
      "clang-22.0.0-git20542-10.webc.gz.bin",
    ],
    licenses: [
      "Apache-2.0.txt",
      "LLVM-exception.txt",
      "wasi-libc-ac020b86-LICENSE.txt",
      "wasi-libc-ac020b86-musl-fts-BSD-3-Clause.txt",
      "wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
      "wasi-libc-b9ef79d-Apache-2.0.txt",
      "wasi-libc-b9ef79d-MIT.txt",
      "wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt",
      "wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt",
      "wasi-libc-b9ef79d-emmalloc-NOTICE.txt",
      "wasi-libc-b9ef79d-musl-MIT.txt",
    ],
  }),
  toolchain("toolchain-rust", {
    id: "rust",
    toolchainVersion: "1.91.1-dev",
    languages: ["rust"],
    targets: ["wasip1"],
    assets: [
      "rust-1.91.1-dev.manifest.json",
      "rust-1.91.1-dev.webc.gz.bin",
    ],
    licenses: [
      "rust-MIT.txt",
      "Apache-2.0.txt",
      "LLVM-exception.txt",
      "rust-COPYRIGHT.txt",
      "rust-COPYRIGHT.html",
      "rust-COPYRIGHT-library.html",
      "libloading-ISC.txt",
      "GPL-3.0.txt",
      "GCC-Runtime-Library-Exception-3.1.txt",
      "wasi-libc-ac020b86-LICENSE.txt",
      "wasi-libc-ac020b86-musl-fts-BSD-3-Clause.txt",
    ],
  }),
  toolchain("toolchain-go", {
    id: "go",
    toolchainVersion: "1.26.5",
    languages: ["go"],
    targets: ["wasip1"],
    assets: [
      "go-1.26.5-wasip1.manifest.json",
      "go-1.26.5-wasip1.stdlib.gz.bin",
      "go-1.26.5-wasip1.webc.gz.bin",
    ],
    licenses: ["go-BSD-3-Clause.txt"],
  }),
  toolchain("toolchain-python", {
    id: "python",
    toolchainVersion: "3.14.7",
    languages: ["python"],
    targets: ["wasip1"],
    assets: [
      "python-3.14.7-wasip1.manifest.json",
      "python-3.14.7-wasip1.webc.gz.bin",
    ],
    licenses: [
      "cpython-3.14.7-PSF-2.0.txt",
      "cpython-expat-2.8.1-MIT.txt",
      "cpython-hacl-star-8ba599b-MIT.txt",
      "cpython-libmpdec-2.5.1-BSD-2-Clause.txt",
      "wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
      "wasi-sdk-24.0-compiler-rt-LICENSE.txt",
      "wasi-libc-b9ef79d-LICENSE.txt",
      "wasi-libc-b9ef79d-Apache-2.0.txt",
      "wasi-libc-b9ef79d-MIT.txt",
      "wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt",
      "wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt",
      "wasi-libc-b9ef79d-emmalloc-NOTICE.txt",
      "wasi-libc-b9ef79d-musl-MIT.txt",
    ],
  }),
  toolchain("toolchain-javascript", {
    id: "javascript",
    toolchainVersion: "typescript-7.0.2+quickjs-0.15.1",
    languages: ["javascript", "typescript"],
    targets: ["wasip1"],
    assets: [
      "quickjs-0.15.1.wasm.gz.bin",
      "typescript-7.0.2.wasm.gz.bin",
    ],
    licenses: [
      "quickjs-ng-MIT.txt",
      "typescript-go-NOTICE.txt",
      "Apache-2.0.txt",
      "go-BSD-3-Clause.txt",
      "wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
      "wasi-sdk-24.0-compiler-rt-LICENSE.txt",
      "wasi-libc-b9ef79d-LICENSE.txt",
      "wasi-libc-b9ef79d-Apache-2.0.txt",
      "wasi-libc-b9ef79d-MIT.txt",
      "wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt",
      "wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt",
      "wasi-libc-b9ef79d-emmalloc-NOTICE.txt",
      "wasi-libc-b9ef79d-musl-MIT.txt",
    ],
  }),
  toolchain("toolchain-java", {
    id: "java-teavm",
    toolchainVersion: "teavm-0.13.1-wasmgc-wasip1",
    languages: ["java"],
    targets: ["wasip1"],
    assets: [
      "java-teavm-0.13.1.compile-classlib.bin",
      "java-teavm-0.13.1.runtime-classlib.bin",
      "java-teavm-0.13.1.compiler.wasm",
    ],
    licenses: [
      "Apache-2.0.txt",
      "openjdk-21-GPL-2.0-with-Classpath-exception.txt",
      "android-libcore-GPL-2.0-with-Classpath-exception.txt",
    ],
  }),
]);

export const PUBLIC_PACKAGES = Object.freeze([...CODE_PACKAGES, ...TOOLCHAIN_PACKAGES]);
export const PUBLIC_PACKAGE_BY_NAME = new Map(PUBLIC_PACKAGES.map((entry) => [entry.name, entry]));
export const WORKSPACE_PACKAGE_PATTERN = /^@wasm-oj\/(?:contracts|core|browser|server|organizer|cli|sdk|toolchain-(?:clang|go|java|javascript|python|rust))(?:\/|$)/u;
