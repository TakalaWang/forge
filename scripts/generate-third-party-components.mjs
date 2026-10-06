import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENT_MANIFEST_PATH,
  COMPONENT_MANIFEST_SCHEMA,
} from "./third-party-components.mjs";
import { readPnpmLock, requireLockedPackage } from "./pnpm-lock.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const lockfile = await readPnpmLock(root);
const runtimeLockSha256 = await fileSha256("crates/runtime-core/Cargo.lock");

const commonWasiLibcLicenses = [
  "licenses/wasi-libc-b9ef79d-Apache-2.0.txt",
  "licenses/wasi-libc-b9ef79d-MIT.txt",
  "licenses/wasi-libc-b9ef79d-cloudlibc-BSD-2-Clause.txt",
  "licenses/wasi-libc-b9ef79d-dlmalloc-CC0-NOTICE.txt",
  "licenses/wasi-libc-b9ef79d-emmalloc-NOTICE.txt",
  "licenses/wasi-libc-b9ef79d-musl-MIT.txt",
  "licenses/wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
];

const definitions = [
  {
    "id": "buffer",
    "name": "buffer",
    "version": "6.0.3",
    "source": {
      "url": "https://github.com/feross/buffer",
      "revision": "v6.0.3"
    },
    "npm": "buffer@6.0.3",
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "readable-stream",
    "name": "readable-stream",
    "version": "4.7.0",
    "source": {
      "url": "https://github.com/nodejs/readable-stream",
      "revision": "v4.7.0"
    },
    "npm": "readable-stream@4.7.0",
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "events",
    "name": "events",
    "version": "3.3.0",
    "source": {
      "url": "https://github.com/Gozala/events",
      "revision": "v3.3.0"
    },
    "npm": "events@3.3.0",
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "abort-controller",
    "name": "abort-controller",
    "version": "3.0.0",
    "source": {
      "url": "https://github.com/mysticatea/abort-controller",
      "revision": "v3.0.0"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "event-target-shim",
    "name": "event-target-shim",
    "version": "5.0.1",
    "source": {
      "url": "https://github.com/mysticatea/event-target-shim",
      "revision": "v5.0.1"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "base64-js",
    "name": "base64-js",
    "version": "1.5.1",
    "source": {
      "url": "https://github.com/beatgammit/base64-js",
      "revision": "v1.5.1"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "ieee754",
    "name": "ieee754",
    "version": "1.2.1",
    "source": {
      "url": "https://github.com/feross/ieee754",
      "revision": "v1.2.1"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "string-decoder",
    "name": "string_decoder",
    "version": "1.3.0",
    "source": {
      "url": "https://github.com/nodejs/string_decoder",
      "revision": "v1.3.0"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  },
  {
    "id": "safe-buffer",
    "name": "safe-buffer",
    "version": "5.2.1",
    "source": {
      "url": "https://github.com/feross/safe-buffer",
      "revision": "v5.2.1"
    },
    "embedded": [
      "src/runtime/quickjs/stdlib.generated.ts"
    ],
    "licenses": [
      "licenses/quickjs-node-stdlib-LICENSES.txt"
    ]
  }
,
  {
    id: "clang-yowasp",
    name: "YoWASP Clang, LLD, libc++, and LLVM runtime payload",
    version: "22.0.0-git20542-10",
    source: {
      url: "https://github.com/YoWASP/clang",
      revision: "944dd7c774954180e621cc8e12984023a7f8bcbe; llvm-project@97196c8eeb1d495fa43bb8af2fb26af5ef5b89fb",
    },
    files: [
      "public/toolchains/clang-22.0.0-git20542-10.cc1-pins.json",
      "public/toolchains/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin",
      "public/toolchains/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin",
      "public/toolchains/clang-22.0.0-git20542-10.libcxx-pch.json",
      "public/toolchains/clang-22.0.0-git20542-10.manifest.json",
      "public/toolchains/clang-22.0.0-git20542-10.webc.gz.bin",
    ],
    licenses: ["licenses/Apache-2.0.txt", "licenses/LLVM-exception.txt"],
  },
  {
    id: "cpython",
    name: "CPython and bundled standard-library third-party components",
    version: "3.14.7",
    source: {
      url: "https://www.python.org/ftp/python/3.14.7/Python-3.14.7.tar.xz",
      revision: "v3.14.7; Expat 2.8.1; HACL* 8ba599b2f6c9701b3dc961db895b0856a2210f76; libmpdec 2.5.1",
    },
    files: [
      "public/toolchains/python-3.14.7-wasip1.manifest.json",
      "public/toolchains/python-3.14.7-wasip1.webc.gz.bin",
    ],
    licenses: [
      "licenses/cpython-3.14.7-PSF-2.0.txt",
      "licenses/cpython-expat-2.8.1-MIT.txt",
      "licenses/cpython-hacl-star-8ba599b-MIT.txt",
      "licenses/cpython-libmpdec-2.5.1-BSD-2-Clause.txt",
    ],
  },
  {
    id: "es-module-lexer",
    name: "es-module-lexer",
    version: "2.3.1",
    source: {
      url: "https://github.com/guybedford/es-module-lexer",
      revision: "2b2e6209bac5c06c6ba457f9730014613e1128fb",
    },
    npm: "es-module-lexer@2.3.1",
    licenses: ["licenses/es-module-lexer-MIT.txt"],
  },
  {
    id: "fflate",
    name: "fflate",
    version: "0.8.3",
    source: {
      url: "https://github.com/101arrowz/fflate",
      revision: "v0.8.3",
    },
    npm: "fflate@0.8.3",
    licenses: ["licenses/fflate-MIT.txt"],
  },
  {
    id: "go-compiler-toolchain",
    name: "Go compiler, linker, standard library, and WASI runtime",
    version: "1.26.5",
    source: {
      url: "https://go.dev/dl/go1.26.5.src.tar.gz",
      revision: "go1.26.5; source archive sha256 495be4bc87176ac567392e5b4116abd98466d33d7b49d41e764ccc6976b2dc42",
    },
    files: [
      "public/toolchains/go-1.26.5-wasip1.manifest.json",
      "public/toolchains/go-1.26.5-wasip1.stdlib.gz.bin",
      "public/toolchains/go-1.26.5-wasip1.webc.gz.bin",
    ],
    licenses: ["licenses/go-BSD-3-Clause.txt"],
  },
  {
    id: "napi-rs-keyring",
    name: "@napi-rs/keyring",
    version: "1.3.0",
    source: {
      url: "https://github.com/Brooooooklyn/keyring-node",
      revision: "e46be75c3ba8d5fde6b88a17c6153b87ffe4b946",
    },
    npm: "@napi-rs/keyring@1.3.0",
    licenses: ["licenses/napi-rs-keyring-MIT.txt"],
  },
  {
    id: "go-typescript-runtime",
    name: "Go standard library and WASI runtime embedded by TypeScript-Go",
    version: "1.26.3",
    source: { url: "https://go.googlesource.com/go", revision: "go1.26.3" },
    embedded: ["public/toolchains/typescript-7.0.2.wasm.gz.bin"],
    licenses: ["licenses/go-BSD-3-Clause.txt"],
  },
  {
    id: "java-teavm",
    name: "TeaVM Java WasmGC compiler and WASI class library",
    version: "teavm-0.13.1-wasmgc-wasip1",
    source: {
      url: "https://github.com/konsoletyper/teavm-javac",
      revision: "teavm-javac@7e4a44cf521694a4e326e33850dd8aec165eb5c9; teavm@b3a245b7d9034ff35cdfab2def057a3d4f256efb plus WASI compiler patch",
    },
    files: [
      "public/toolchains/java-teavm-0.13.1.compile-classlib.bin",
      "public/toolchains/java-teavm-0.13.1.runtime-classlib.bin",
      "public/toolchains/java-teavm-0.13.1.compiler.wasm",
    ],
    licenses: [
      "licenses/Apache-2.0.txt",
      "licenses/openjdk-21-GPL-2.0-with-Classpath-exception.txt",
    ],
  },
  {
    id: "android-libcore-scanner",
    name: "Android libcore Scanner and Spliterators",
    version: "de876a01b29230b877c9f408348c38a90ee724a5",
    source: {
      url: "https://android.googlesource.com/platform/libcore/",
      revision: "de876a01b29230b877c9f408348c38a90ee724a5",
    },
    files: [
      "public/toolchains/java-teavm-0.13.1.compile-classlib.bin",
      "public/toolchains/java-teavm-0.13.1.runtime-classlib.bin",
    ],
    licenses: ["licenses/android-libcore-GPL-2.0-with-Classpath-exception.txt"],
  },
  {
    id: "quickjs-ng",
    name: "QuickJS-ng",
    version: "0.15.1",
    source: {
      url: "https://github.com/quickjs-ng/quickjs",
      revision: "fd0a0210b7be00957751871e7e01b8291268fc29",
    },
    files: ["public/toolchains/quickjs-0.15.1.wasm.gz.bin"],
    licenses: ["licenses/quickjs-ng-MIT.txt"],
  },
  {
    id: "runtime-core-dependencies",
    name: "WASM-OJ runtime-core locked normal dependency closure",
    version: `Cargo.lock-${runtimeLockSha256}`,
    source: { url: "https://crates.io/", revision: runtimeLockSha256 },
    files: [
      "licenses/runtime-core-dependencies.html",
      "licenses/runtime-core-dependencies.json",
    ],
    licenses: [
      "licenses/runtime-core-dependencies.html",
      "licenses/runtime-core-dependencies.json",
    ],
  },
  {
    id: "rust-toolchain",
    name: "Rust compiler, standard library, LLVM, GCC runtime, and libloading closure",
    version: "1.91.1-dev",
    source: {
      url: "https://github.com/olimpiadi-informatica/wasm-compilers",
      revision: "ae62cab6adf0665377d19ffa39daeaf758290431; rust@ed61e7d7e242494fb7057f2657300d9e77bb4fcb; llvm@87f0227cb60147a26a1eeb4fb06e3b505e9c7261; gcc@ae91b5dd14920ff9671db8ff80c0d763d25f977f",
    },
    files: [
      "public/toolchains/rust-1.91.1-dev.manifest.json",
      "public/toolchains/rust-1.91.1-dev.webc.gz.bin",
    ],
    licenses: [
      "licenses/Apache-2.0.txt",
      "licenses/GCC-Runtime-Library-Exception-3.1.txt",
      "licenses/GPL-3.0.txt",
      "licenses/LLVM-exception.txt",
      "licenses/libloading-ISC.txt",
      "licenses/rust-COPYRIGHT-library.html",
      "licenses/rust-COPYRIGHT.html",
      "licenses/rust-COPYRIGHT.txt",
      "licenses/rust-MIT.txt",
    ],
  },
  {
    id: "typescript-go",
    name: "TypeScript-Go",
    version: "7.0.2",
    source: {
      url: "https://github.com/microsoft/typescript-go",
      revision: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b",
    },
    files: ["public/toolchains/typescript-7.0.2.wasm.gz.bin"],
    licenses: ["licenses/Apache-2.0.txt", "licenses/typescript-go-NOTICE.txt"],
  },
  {
    id: "wasi-libc-ac020b86",
    name: "WASI libc embedded by YoWASP Clang",
    version: "ac020b86fd44bafe60aa4fa12f407d16e3731329",
    source: {
      url: "https://github.com/WebAssembly/wasi-libc",
      revision: "ac020b86fd44bafe60aa4fa12f407d16e3731329",
    },
    embedded: [
      "public/toolchains/clang-22.0.0-git20542-10.webc.gz.bin",
      "public/toolchains/rust-1.91.1-dev.webc.gz.bin",
    ],
    licenses: [
      "licenses/wasi-libc-ac020b86-LICENSE.txt",
      "licenses/wasi-libc-ac020b86-musl-fts-BSD-3-Clause.txt",
      ...commonWasiLibcLicenses,
    ],
  },
  {
    id: "wasi-libc-b9ef79d",
    name: "WASI libc embedded by WASI SDK 24",
    version: "b9ef79d7dbd47c6c5bafdae760823467c2f60b70",
    source: {
      url: "https://github.com/WebAssembly/wasi-libc",
      revision: "b9ef79d7dbd47c6c5bafdae760823467c2f60b70",
    },
    embedded: [
      "public/toolchains/python-3.14.7-wasip1.webc.gz.bin",
      "public/toolchains/quickjs-0.15.1.wasm.gz.bin",
    ],
    licenses: ["licenses/wasi-libc-b9ef79d-LICENSE.txt", ...commonWasiLibcLicenses],
  },
  {
    id: "wasi-sdk-24",
    name: "WASI SDK, LLVM compiler-rt, and build toolchain closure",
    version: "24.0",
    source: {
      url: "https://github.com/WebAssembly/wasi-sdk",
      revision: "d2bea01edcc46f731156a817f710cdd9fc9c1c19; llvm@26a1d6601d727a96f4301d0d8647b5a42760ae0c; wasi-libc@b9ef79d7dbd47c6c5bafdae760823467c2f60b70",
    },
    embedded: [
      "public/toolchains/python-3.14.7-wasip1.webc.gz.bin",
      "public/toolchains/quickjs-0.15.1.wasm.gz.bin",
    ],
    licenses: [
      "licenses/wasi-sdk-24.0-Apache-2.0-LLVM-exception.txt",
      "licenses/wasi-sdk-24.0-compiler-rt-LICENSE.txt",
    ],
  },
  {
    id: "wasmer-sdk",
    name: "Wasmer JavaScript SDK and locked Rust dependency closure",
    version: "0.19.0",
    source: {
      url: "https://github.com/wasmerio/wasmer-sdk",
      revision: "7e69332b7f65dbc5584d64bb79f547eaf4302b69",
    },
    files: [
      "licenses/wasmer-sdk-dependencies.html",
      "licenses/wasmer-sdk-dependencies.json",
    ],
    npm: "@wasmer/sdk@0.19.0",
    licenses: [
      "licenses/wasmer-sdk-LICENSE.txt",
      "licenses/wasmer-sdk-acorn-MIT.txt",
      "licenses/wasmer-sdk-dependencies.html",
      "licenses/wasmer-sdk-dependencies.json",
    ],
  },
];

const components = [];
for (const definition of definitions) {
  const distributions = [];
  for (const relative of definition.embedded ?? []) {
    distributions.push({ kind: "embedded", container: relative, sha256: await fileSha256(relative) });
  }
  for (const relative of definition.files ?? []) {
    distributions.push({ kind: "file", path: relative, sha256: await fileSha256(relative) });
  }
  if (definition.npm) {
    const separator = definition.npm.lastIndexOf("@");
    const packageName = definition.npm.slice(0, separator);
    const locked = requireLockedPackage(lockfile, packageName, definition.npm.slice(separator + 1));
    distributions.push({ kind: "npm", package: definition.npm, integrity: locked.integrity });
  }
  distributions.sort((left, right) => compareCodePoints(identity(left), identity(right)));

  const licenseFiles = [];
  for (const relative of [...new Set(definition.licenses)].sort(compareCodePoints)) {
    licenseFiles.push({ path: relative, sha256: await fileSha256(relative) });
  }
  components.push({
    id: definition.id,
    name: definition.name,
    version: definition.version,
    source: definition.source,
    distributions,
    licenseFiles,
  });
}
components.sort((left, right) => compareCodePoints(left.id, right.id));

const output = path.join(root, COMPONENT_MANIFEST_PATH);
const temporary = `${output}.${process.pid}.tmp`;
const bytes = `${JSON.stringify({ schema: COMPONENT_MANIFEST_SCHEMA, components }, null, 2)}\n`;
try {
  await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o644 });
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
process.stdout.write(`Generated ${COMPONENT_MANIFEST_PATH} with ${components.length} components.\n`);

async function fileSha256(relative) {
  const bytes = await readFile(path.join(root, relative));
  if (bytes.byteLength === 0) throw new Error(`Cannot inventory empty file '${relative}'.`);
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(distribution) {
  if (distribution.kind === "file") return `file:${distribution.path}`;
  if (distribution.kind === "embedded") return `embedded:${distribution.container}`;
  return `npm:${distribution.package}`;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
