# WASM-OJ SDK integration guide

WASM-OJ exposes one host-neutral contract and separate browser, server, and Organizer adapters.
Choose imports by ownership boundary; do not import browser code into a Node.js service or server
code into a client bundle.

## Package boundaries

```text
@wasm-oj/contracts → @wasm-oj/core
                   ↘ @wasm-oj/browser ┐
                   ↘ @wasm-oj/server  ├→ @wasm-oj/sdk
                   ↘ @wasm-oj/organizer ┘
@wasm-oj/core + @wasm-oj/server + @wasm-oj/organizer → @wasm-oj/cli
```

| Import | Purpose |
| --- | --- |
| `@wasm-oj/contracts` | Contract constants, wire/error types, and toolchain source models |
| `@wasm-oj/core` | Host-neutral engine, compiler/runner interfaces, judge, dependency, replay, and conformance APIs |
| `@wasm-oj/browser` | Browser Workers, browser storage, runtime-driver plug-ins, and `createBrowserEngine()` |
| `@wasm-oj/server` | Node.js/Wasmer processes, filesystem stores, and `createServerEngine()` |
| `@wasm-oj/organizer` | Repository manifest, public projection, and deployable judge-package validation |
| `@wasm-oj/cli` | Single local-first `woj` executable for Student and Organizer journeys |
| `@wasm-oj/sdk` | Convenience root re-export of the host-neutral contracts and core APIs |
| `@wasm-oj/sdk/contracts`, `@wasm-oj/sdk/browser`, `@wasm-oj/sdk/server`, `@wasm-oj/sdk/organizer` | Explicit convenience subpaths that re-export those same package instances |

All active APIs implement `WASM_OJ_CONTRACT_VERSION === 2` and
`WASM_OJ_CONTRACT_ID === "wasm-oj-v2"`. Unsupported language/target/profile pairs and older wire
shapes fail before execution.

## Explicit toolchain sources

Toolchains are installed separately from code packages:

```sh
pnpm add @wasm-oj/browser \
  @wasm-oj/toolchain-clang \
  @wasm-oj/toolchain-rust \
  @wasm-oj/toolchain-go \
  @wasm-oj/toolchain-python \
  @wasm-oj/toolchain-javascript \
  @wasm-oj/toolchain-java
```

Each package exports an immutable contract-2 `descriptor`, `browserSource(baseUrl)`, and
`serverSource()`. A descriptor binds its package identity, languages, build profiles, logical asset
paths, byte lengths, SHA-256 digests, and package export paths.

Hosts require a non-empty source array. They do not use a default CDN, package search, current
working directory, or `/toolchains/` fallback. A language, profile, or asset can have exactly one
owner.

## Browser host

```ts
import {
  BrowserDependencyNetworkConsent,
  createBrowserEngine,
  registerToolchainCache,
} from "@wasm-oj/browser";
import { browserSource as clangSource } from "@wasm-oj/toolchain-clang";
import { browserSource as rustSource } from "@wasm-oj/toolchain-rust";
import { browserSource as goSource } from "@wasm-oj/toolchain-go";
import { browserSource as pythonSource } from "@wasm-oj/toolchain-python";
import { browserSource as javascriptSource } from "@wasm-oj/toolchain-javascript";
import { browserSource as javaSource } from "@wasm-oj/toolchain-java";

await registerToolchainCache({
  scriptUrl: "/toolchain-cache-sw.js",
  scope: "/",
});

const dependencyConsent = new BrowserDependencyNetworkConsent(
  window.localStorage,
  async ({ hosts }) => window.confirm(
    `Allow this problem bundle to download dependencies from:\n${hosts.join("\n")}`,
  ),
);

const baseUrl = "/toolchains/";
const engine = await createBrowserEngine({
  toolchains: [
    clangSource(baseUrl),
    rustSource(baseUrl),
    goSource(baseUrl),
    pythonSource(baseUrl),
    javascriptSource(baseUrl),
    javaSource(baseUrl),
  ],
  artifactCache: true,
  dependencyNetworkAuthorizer: dependencyConsent,
});
```

`baseUrl` identifies the HTTP directory containing the descriptor's asset basenames. It may be
root-relative or an absolute HTTP(S) URL; `browserSource()` canonicalizes the stored directory URL
with a trailing `/`. Every fetched response is checked against the descriptor's exact byte length
and digest before use.

The page must be cross-origin isolated: COOP `same-origin`, COEP `require-corp`, CORP
`same-origin`, and `worker-src 'self' blob:` are required. Cross-origin asset servers must emit
compatible CORS/CORP headers.

### Prefetching a toolchain

A first build downloads its toolchain inside the compiler request, so a slow network can spend the
whole build boundary on the download (60 s for C/C++). Hosts that know the language before the
user builds can download it earlier:

```ts
import { prefetchBrowserToolchain } from "@wasm-oj/browser";

await prefetchBrowserToolchain(toolchains, {
  language: "cpp",
  signal,
  onProgress: ({ loadedBytes, totalBytes }) => render(loadedBytes / totalBytes),
});
```

It requests exactly the digest-addressed URLs the Workers request for that language (optimization
defaults to `release`; pass `libcxxPrecompiledHeader: true` for C++ projects that ship
`wasm-oj.pch.hpp`), checks each response's byte length, and rejects on any failure so the host can
retry. Later builds read the bytes from the HTTP cache, or from the toolchain cache when
`registerToolchainCache()` controls the page, so serve toolchain assets with a cacheable
`Cache-Control` (they are immutable per digest).

## Server host

Build the packaged native executables while constructing the deployment image:

```sh
pnpm --dir node_modules/@wasm-oj/server run runtime:build-native
```

Create a host with explicit runtime and toolchain locations:

```ts
import { createServerEngine } from "@wasm-oj/server";
import { serverSource as clangSource } from "@wasm-oj/toolchain-clang";
import { serverSource as rustSource } from "@wasm-oj/toolchain-rust";
import { serverSource as goSource } from "@wasm-oj/toolchain-go";
import { serverSource as pythonSource } from "@wasm-oj/toolchain-python";
import { serverSource as javascriptSource } from "@wasm-oj/toolchain-javascript";
import { serverSource as javaSource } from "@wasm-oj/toolchain-java";

const engine = await createServerEngine({
  runtimeDirectory: "/srv/wasm-oj/runtime/release",
  cacheDirectory: "/var/cache/wasm-oj",
  toolchains: [
    clangSource(),
    rustSource(),
    goSource(),
    pythonSource(),
    javascriptSource(),
    javaSource(),
  ],
});
```

`runtimeDirectory` must contain executable regular files named `wasm-oj-compiler` and
`wasm-oj-runner` (with `.exe` on Windows). `serverSource()` resolves only its installed package's
read-only `assets/` directory. Startup checks file type, size, and digest and never downloads,
builds, searches for, or substitutes a missing distribution.

## Compile and run

```ts
const build = await engine.compile({
  language: "typescript",
  target: "wasip1",
  optimization: "release",
  entry: "src/main.ts",
  files: {
    "src/main.ts": 'import * as std from "std";\nconst answer: number = 42;\nstd.out.puts(`${answer}\\n`);',
  },
});

if (!build.success || !build.artifact) {
  renderDiagnostics(build.diagnostics);
} else {
  const run = await engine.run(build.artifact, {
    args: [],
    stdin: "",
    env: {},
  });
  renderOutput(run.stdout, run.stderr, run.termination);
}
```

Compiler diagnostics, guest termination, and judge verdicts are result data. Infrastructure
failures use `WasmOjError`, whose `code`, `stage`, `retryable`, optional operation ID, and bounded
details can be serialized with `toJSON()`.

## Submission-scoped operations

`submit()` is the queueing, observation, cancellation, and ownership boundary:

```ts
import {
  WASM_OJ_CONTRACT_VERSION,
  WasmOjError,
  textMatcher,
} from "@wasm-oj/core";

const stopObserving = engine.onObservation((event) => {
  persistObservation(event.operationId, event.sequence, event);
});

const operation = engine.submit({
  id: "submission-018f",
  input: {
    language: "rust",
    target: "wasip1",
    entry: "main.rs",
    files: { "main.rs": 'fn main() { println!("42"); }' },
  },
  spec: {
    version: WASM_OJ_CONTRACT_VERSION,
    failFast: false,
    cases: [{
      kind: "batch",
      id: "sample-1",
      input: { kind: "inline", value: "" },
      matcher: textMatcher("42\n"),
    }],
  },
});

const stopOperationEvents = operation.onEvent(renderLiveEvent);
try {
  const { build, judge } = await operation.result;
  renderDiagnostics(build.diagnostics);
  renderVerdict(judge?.verdict);
} catch (error) {
  if (error instanceof WasmOjError) recordInfrastructureFailure(error.toJSON());
  else throw error;
} finally {
  stopOperationEvents();
  stopObserving();
}
```

Operations are FIFO within one engine. Cancelling a queued operation does not cancel the active
one. While a submission is pending, direct execution and cache mutation reject with
`operation-conflict`, preventing work from crossing submission ownership.

## Dependency network authorization

Resolution and archive materialization are separate verified steps. Online resolution requires
both the host's authorizer and an immutable per-request scope:

```ts
declare const loadedProblem: {
  repositorySourceKey: string;
  problemBundleSha256: string;
  completeDependencyHosts: readonly string[];
};

const manifest = {
  requirements: [{ ecosystem: "npm", name: "left-pad", requirement: "1.3.0" }],
  sourceFiles: [{
    ecosystem: "npm",
    role: "lockfile",
    path: "package-lock.json",
    contents: packageLockText,
  }],
} as const;

const lock = await engine.resolveDependencies(manifest, {
  networkAccess: {
    sourceKey: loadedProblem.repositorySourceKey,
    bundleDigest: loadedProblem.problemBundleSha256,
    hosts: loadedProblem.completeDependencyHosts,
  },
});
const dependencies = await engine.prepareDependencies(lock);
const build = await engine.compile({
  language: "javascript",
  target: "wasip1",
  entry: "src/main.js",
  files: {
    "src/main.js": 'const std = require("std");\nconst pad = require("left-pad");\nstd.out.puts(`${pad("7", 3, "0")}\\n`);',
  },
  dependencies,
});
```

The built-in resolvers accept only their documented lock-based portable subsets. Redirects,
credentials, insecure/private hosts, ranges, scripts, native extensions, unsupported source forms,
and integrity mismatches fail closed. Explicit offline resolution uses verified cached payloads and
never invokes `fetch`.

## Runtime-driver plug-ins

Browser runtime-driver plug-ins are trusted host code, not contestant extensions. Bundle each as
one self-contained same-origin ESM module and pin the exact bytes:

```ts
const engine = await createBrowserEngine({
  toolchains,
  runtimeDriverPlugins: [{
    id: "acme-runtime-v1",
    moduleUrl: "/wasm-oj-plugins/acme-runtime.mjs",
    sha256: "<lowercase SHA-256>",
  }],
});
```

The Worker rejects redirects, cross-origin URLs, unpinned bytes, nested imports, duplicate IDs,
missing factory exports, and drivers whose runtime identity differs from the descriptor.

## Replay and binary formats

`createReplayBundle()`, `encodeReplayBundle()`, and `decodeReplayBundle()` use the canonical
`WOJRPL02` envelope. Judge packages use `WOJJDG02`; runtime filesystem archives use `WOJFS002`;
Go shared files use `WOJGO002`. Decoders reject older magic, non-canonical manifests, digest
mismatches, unused/missing blobs, trailing bytes, and contract drift.

## Lifecycle

Call `dispose()` when a host is no longer used. `clearCache()` is an exclusive engine operation: it
cancels accepted compiler work, waits for runner work to stop, then clears configured compiler,
runtime, dependency, and artifact storage. Browser worker replacement and server child processes
remain hard isolation boundaries for cancellation, timeout, restart, and infrastructure failure.

See [library-contract.md](library-contract.md) for invariant-level details and
[versioning.md](versioning.md) for compatibility rules.

## Comparing with a native online judge

Browser/server conformance means the same WASM-OJ toolchains and execution contract on both hosts. It does not establish full standard-library or platform compatibility with native GCC, OpenJDK, CPython, or Node.js. JavaScript and TypeScript use QuickJS with the SDK's `std` module and a bounded Node-compatible standard I/O surface: `fs`/`node:fs` synchronous fd 0/1/2 reads and writes, `process` readable/writable standard streams, nonterminal `readline` callbacks and async iteration, and `buffer` text/binary conversion. These use one shared stdin byte cursor. General filesystem access, terminal interaction, subprocesses, and the remaining Node builtins are unavailable; unsupported imports or APIs fail instead of returning mock success. The TeaVM Java class library is not a full OpenJDK runtime.

Preserve the same input bytes in both paths, including EOF, CRLF, empty input, and trailing whitespace. Do not append a newline or trim stdin to hide a program's EOF bug. Output-validator whitespace rules apply to the produced output, not to program input. `std.in.readAsString()` consumes the remaining input; subsequent reads return an empty string.

The full conformance suite includes `*-wasip1-stdio-*` cases for every supported language: empty input, LF, absent/final LF, repeated LF, CRLF, bare CR, spaces/tabs, Unicode, BOM, NUL, long lines, and an unterminated last line. These check exact UTF-8 input bytes with each toolchain's supported I/O API, except Java, which checks BufferedReader line semantics against native behavior. Lower-level Java byte I/O is not covered by this passing corpus. Integrators must additionally test their users' native APIs and their configured output validator; a simple arithmetic smoke test is insufficient.
