# WASM-OJ library contract

This document defines the active contract-2 invariants shared by browser and server hosts. Public
symbols live in the seven npm code packages; toolchain bytes live in six independently versioned
asset packages.

## Compatibility boundary

```ts
WASM_OJ_CONTRACT_VERSION = 2
WASM_OJ_CONTRACT_ID = "wasm-oj-v2"
```

One number governs compiler/runner requests, artifacts, deterministic inputs, resource accounting,
judge specifications, dependency locks, replay, toolchain descriptors, caches, and conformance
evidence. A breaking change increments this number once and resets every affected schema/storage
identity atomically. Contract 1 shapes are rejected; no alias, migration shim, or fallback path is
part of contract 2.

Package SemVer and upstream toolchain versions are separate. Multiple synchronized SDK releases
may implement contract 2, while each toolchain package may release independently as long as its
descriptor declares the supported contract.

## Package dependency graph

```text
contracts
   │
   ▼
 core
 ┌─┼──────────┐
 ▼ ▼          ▼
browser    server    organizer
 └──────────┬─────────┘
            ├──────────────▶ sdk
 core ──────┬──────────────▶ cli
 server ────┤
 organizer ─┘
```

- `@wasm-oj/contracts` is environment-neutral and has no runtime dependencies.
- `@wasm-oj/core` depends on no other WASM-OJ package except contracts and owns orchestration, not
  host I/O. Audited host-neutral implementation dependencies such as `fflate` do not add an
  architectural package edge.
- `@wasm-oj/browser`, `@wasm-oj/server`, and `@wasm-oj/organizer` depend on contracts/core and do
  not depend on each other.
- `@wasm-oj/cli` depends on core, server, and Organizer to expose one local-first executable. It
  acquires toolchain bytes only through an explicit `woj toolchain fetch`; it does not install a
  toolchain package.
- `@wasm-oj/sdk` is a convenience façade. It re-exports package instances and must not bundle a
  second embedded core.
- Toolchain packages depend only on the contract types needed for their descriptor. No code
  package selects, downloads, or bundles a toolchain package implicitly.

## Public engine abstractions

`Compiler`, `Runner`, `ArtifactStore`, and optional `DependencyManager` are injected into `Engine`.
`createEngine()` awaits both host adapters and disposes partial construction on failure.

A `Compiler`:

- owns a stable `cacheIdentity(project)` that changes for every output-affecting compiler,
  descriptor, profile, and asset identity;
- validates projects before crossing a process/Worker boundary;
- accepts one mutable build operation at a time; and
- exposes explicit ready, cancel, restart, cache-clear, progress, and dispose lifecycle methods.

A `Runner`:

- executes only validated contract-2 artifacts;
- applies deterministic input and resource policy before entering guest code;
- keeps infrastructure failures distinct from guest termination; and
- exposes equivalent cancellation, runtime-cache, progress/stream, and disposal boundaries.

`CompilerRegistry` permits downstream compilers with unique language ownership. It seals routing on
first use, rejects ambiguous registration, and owns each compiler lifecycle exactly once.

## Explicit toolchain source contract

Every toolchain package exports this logical model:

```ts
interface ToolchainDescriptor {
  schema: "wasm-oj-v2/toolchain-package";
  id: string;
  version: string;
  wasmOjContract: 2;
  languages: readonly Language[];
  profiles: readonly {
    language: Language;
    target: "wasip1" | "wasix";
    optimization: "debug" | "release";
  }[];
  assets: readonly {
    path: `/toolchains/${string}`;
    bytes: number;
    sha256: string;
    exportPath: `./assets/${string}`;
  }[];
}
```

`browserSource(baseUrl)` returns `{ kind: "browser", descriptor, baseUrl }`. It accepts an explicit
root-relative or absolute HTTP(S) directory and normalizes the returned directory URL to end in
`/`; raw source objects must already satisfy that canonical form.

`serverSource()` returns `{ kind: "server", descriptor, directory }`, where `directory` is the
installed package's query-free `file:` URL ending in `/`.

Host initialization validates exact keys, schema, contract, identifiers, language/profile
coverage, canonical asset paths, positive safe byte lengths, lowercase SHA-256, package export
paths, and unique ownership across the complete source list. Browser fetch and server file reads
verify both size and digest. Missing assets and unregistered profiles fail; neither host has a
default source or search path.

## Browser execution boundary

`createBrowserEngine({ toolchains })` composes `BrowserCompiler`, `BrowserRunner`, browser
artifacts, IndexedDB dependencies, and optional host authorization. It snapshots descriptors before
creating Workers, so caller mutation cannot change an admitted distribution.

Compiler and runner module Workers receive only structured-cloned requests. Browser C/C++ keeps
bounded immutable compiler and content-addressed build-graph state; Rust and Go use serialized
nested stages with bounded lifetime. Python and JavaScript package source files directly. Changing retained families,
crossing a stage budget, cancellation, timeout, restart, cache clearing, disposal, or infrastructure
failure establishes a complete Worker-generation boundary.

Wasmer secondary Workers are host implementation details. They use the SDK's supported `workerUrl`
protocol and do not grant guest thread-spawn capability. The host page must be cross-origin
isolated. The SDK terminates a secondary Worker whenever a WASIX thread or process ends; WASM-OJ
holds those terminations until the current build or run ends, and starts the next one only after
250 ms without a termination. JavaScriptCore crashes the page when a shared `WebAssembly.Memory`
grows while a Worker whose instance imported it is being torn down, and the SDK's Workers share one
memory that grows throughout a build.

## Server execution boundary

`createServerEngine({ runtimeDirectory, toolchains })` requires an explicit directory containing
`wasm-oj-compiler` and `wasm-oj-runner` and explicit package-owned server toolchain sources.
Initialization verifies executable regular files and every descriptor asset before constructing
the engine.

Each server build uses a fresh isolated compiler child. Each execution uses the native Rust runtime
process and a bounded request/response transport. Server startup never provisions binaries,
downloads assets, invokes a host compiler for user source, follows a symlink-owned toolchain path,
or falls back to another directory.

The default writable cache root is `.wasm-oj` below the current working directory when the caller
does not provide `cacheDirectory`; a filesystem root is never accepted.

## Project and artifact identity

A project has one normalized entry path, bounded source files, a language/target/optimization
profile, deterministic configuration, resource policy, and optional verified dependency bundle.
Build identity includes:

- project identity and canonical source paths/content;
- language, target, optimization, and entry;
- compiler cache identity and exact descriptor assets; and
- dependency lock digest plus each materialized package tree digest.

`WasmArtifact` and `RuntimeBundleArtifact` carry `wasmOjContract: 2`, cache identity, language,
target, optimization, toolchain provenance, and exact cost profile. Validation rejects a missing or
foreign contract, metadata mismatch, invalid Wasm header, malformed runtime manifest, impossible
size, or stale cache identity.

## Compile-ahead and cache behavior

`CompileCoordinator` serializes compiler mutation. A matching foreground request may join the exact
in-flight precompile; a changed request cancels stale speculative work. A cached artifact is used
only after its complete project/cache/artifact identity is revalidated. Invalid entries are removed
instead of returned.

Browser build-graph nodes and server artifact files are content addressed. Warning-producing
translation units are rebuilt when diagnostics cannot be reconstructed faithfully. Cache clearing
is explicit and scoped to WASM-OJ-owned storage identities.

## Dependency contract

`DependencyManifest` declares ecosystem requirements and optional native manifest/lock/source
files. Resolution produces a canonical `DependencyLock`; preparation materializes a verified,
archive-independent `DependencyBuildBundle`. Compilers never consume an unchecked archive.

The built-in manager is constructed with host-owned network authority:

```ts
const manager = createDefaultDependencyManager(cache, {
  networkAuthorizer: dependencyNetworkAuthorizer,
});
```

Online browser resolution additionally binds consent to immutable repository input:

```ts
declare const loadedProblem: {
  repositorySourceKey: string;
  problemBundleSha256: string;
  completeDependencyHosts: readonly string[];
};

await manager.resolve(manifest, {
  networkAccess: {
    sourceKey: loadedProblem.repositorySourceKey,
    bundleDigest: loadedProblem.problemBundleSha256,
    hosts: loadedProblem.completeDependencyHosts,
  },
});
```

Cargo, npm, PyPI, Go, and C/C++ adapters accept only their documented exact lock formats and
portable subsets. They reject ranges, redirects, insecure/private hosts, credentials, local
replacements, scripts, proc macros, native extensions, platform-only payloads, unsupported build
constraints, and integrity drift.

Offline mode requires a manifest-matching lock and verified cache payload for every package. A
previous lock may be reused after a genuine transport failure only when its network scope matches
exactly and all payloads verify. HTTP, metadata, integrity, size, and stream failures do not trigger
an implicit cache fallback.

## Determinism and resource policy

The runner controls guest-visible randomness and time from explicit `randomSeed`,
`realtimeEpochMs`, and `clockStepNs`. It validates imported capabilities before instantiation and
enforces:

- baseline-normalized weighted instruction cost;
- deterministic logical time;
- peak guest linear memory;
- combined output bytes;
- live filesystem byte/entry growth; and
- a host-only wall deadline.

Wall duration is observational and excluded from deterministic transcripts and scoring. A normal
guest exit or resource termination is a `RunResult`, not an infrastructure exception.

The artifact cost profile has the form
`wasm-oj-cost:contract-2:<language>:<target>:<optimization>:content-…:weighted` and binds the exact
compiler/runtime content. Judging rejects a profile mismatch rather than guessing a baseline.

## Judge contract

`JudgeSpec.version` is contract 2. Batch cases mount bounded input/files, collect declared output
paths, and apply one matcher. Built-ins cover text, SHA-256, tokens, floating-point tolerance,
set/multiset, output-file sets, and standalone sandboxed Wasm checkers.

Interactive cases start contestant and interactor concurrently with full-duplex pipes, independent
resource policies, process-local deterministic clocks, and secret inputs mounted only on the
interactor side. Either side may be a standalone Wasm module or a runtime bundle such as CPython;
runtime bundles that cannot provide streaming fd 0 are rejected for interaction.

Each case executes under the broad hard policy once. Correct output and the same normalized metrics
are evaluated against ordered cumulative `baseline`, `efficient`, and `optimal` policies. The
portable compute metric is `RunResult.metrics.cost`; wall time is only a safety boundary.

## Organizer versus Official Submit

Organizer validates a collection's canonical schema, normalized paths, declared byte lengths,
digests, redaction rules, and whether immutable `WOJJDG02` bytes are deployable. It does not compile,
run, benchmark, score, or assess reference solutions. No Organizer validation path starts a judge
Container.

Official Submit accepts canonical user source only. The OJ resolves an already published immutable
judge package, compiles the submission in a one-shot Container without public dependency network,
executes cases, and records the authorized result. Client artifacts, claimed limits, and claimed
verdicts are never trusted.

## Replay contract

`ReplayBundle` captures normalized source, stable artifact identity, optional verified offline
dependencies, one exact run or self-contained judge operation, and its deterministic result.
`encodeReplayBundle()` emits `WOJRPL02` with sorted digest-addressed blobs.

Decoding verifies bounds, binary magic, canonical JSON, contract/schema, every blob digest and
reference, and absence of unused/trailing bytes. Recompile replay compares stable artifact identity
before rerunning; artifact-only replay is explicit.

## Storage coordination

Browser storage participants cover artifacts, dependencies, build graph, runtime files, and
toolchains. `StorageCoordinator` applies one exclusive Web Lock to admission, maintenance, and
clearing. Entries publish exact logical length and last access; malformed metadata is removed, not
estimated. Retention priority keeps expensive immutable toolchains above rebuildable data.

Server stores use explicit cache directories, atomic content-addressed files, and no symlink
traversal. Neither host treats a cache as an authority: bytes and identity are revalidated at use.

## Binary formats

| Purpose | Contract-2 magic |
| --- | --- |
| Replay | `WOJRPL02` |
| Judge package | `WOJJDG02` |
| Runtime filesystem | `WOJFS002` |
| Go shared files | `WOJGO002` |

Binary readers reject older magic and do not probe alternate decoders.

## Errors and observation

`WasmOjError` is the stable infrastructure envelope. Compile diagnostics, guest resource
termination, and judge verdicts remain normal result data. `Operation` owns one ID, FIFO state,
abort boundary, result promise, and sequenced observation stream. Listener failures are isolated
from execution.

## Conformance

Browser and server conformance snapshots use `wasm-oj-v2/conformance`. Comparison binds artifact
digests and deterministic transcripts, including logical time and normalized cost. Current
contract-2 evidence is authoritative for contract 2 only; historical contract-1 reports are not a
compatibility promise.

Any incompatible artifact, judge, compiler, runner, determinism, metering, resource, extension,
wire, storage, or conformance change follows [versioning.md](versioning.md).
