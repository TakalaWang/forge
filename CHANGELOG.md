# Changelog

All notable changes to WASM-OJ are recorded here. Releases follow
[Semantic Versioning](https://semver.org/) and the contract/package versioning policy in
[the versioning policy](docs/versioning.md).

## Unreleased

- Interactive contestants and interactors now use the same in-module instruction meter as
  standalone runs, and the runtime reads each program's counter when it exits. They are charged
  exactly what a standalone run charges for the same code; the previous host meter left out the
  meter's own per-block cost, so tight loops cost up to 11 times less. They also run as fast as
  standalone runs; a tight loop used to run about 18 times slower under `interact`, so CPU-bound
  contestants hit the wall deadline before their instruction budget. Interactive costs rise to the
  standalone values, and the refreshed runtime identity changes cost profiles.
- Accept runtime-bundle interactors (for example CPython) in `Runner.interact` on the server
  and in the browser runner Worker. Either side of an interactive session may now be a
  standalone Wasm module or a runtime bundle that provides streaming fd 0.

## 0.2.3 - 2026-10-05

- Download pinned browser toolchain assets before the compiler timeout starts, so slow
  networks do not consume the build boundary. Completed downloads can be reused by
  replacement Workers through the browser HTTP cache or registered toolchain cache.
- Export `prefetchBrowserToolchain` with byte progress and cancellation so hosts can
  download the selected language's toolchain before a build.
- Kept the execution contract at version 2. The seven code packages move together to 0.2.3;
  independently versioned toolchain packages remain at 0.2.0.

## 0.2.2 - 2026-09-10

- Fixed browser toolchain execution under strict Content Security Policy and kept isolated
  Wasmer runtime preparation alive until it completes.
- Aligned client execution with native language semantics, including Java compilation through
  TeaVM WasmGC, QuickJS standard-library support, and Python 3.14.7.
- Preserved deterministic execution by removing host-clock mode and corrected native Linux
  parity checks to use file-backed standard input.
- Fixed npm tarball publication paths and added release retries from existing immutable tags.
- Kept the execution contract at version 2. The seven code packages move together to 0.2.2;
  independently versioned toolchain packages remain at 0.2.0.

## 0.2.1 - 2026-09-08

- Replaced managed collection APIs with repository-authored catalogs. `wasm-oj.json` and an
  exact Git commit now define catalog content; Organizer exports repository parsers and static
  validation instead of managed collection parsers.
- Replaced the CLI collection validation/publication/activation workflow with `woj organizer
  catalog connect` and `catalog sync`. Problem commands use stable problem IDs, and rejudge
  commands select commit-to-commit targets. Existing CLI integrations must update their commands.
- Added declarative contest rules and Prompt Program repository authoring. Organizer collection
  builds validate and package deployable judge data without executing reference solutions.
- Fixed redirected standard input/output handling in the shared runtime and stdin consumption
  in QuickJS execution; refreshed the browser runtime and its pinned content identity.
- Kept the WASM-OJ execution contract at version 2. The seven code packages move together to
  0.2.1; independently versioned toolchain assets remain at 0.1.0.

## 0.2.0 - 2026-08-20

- Replaced the experimental contract with the breaking WASM-OJ contract 2 boundary.
- Split the public API into contracts, core, browser, server, organizer, CLI, and SDK, plus six
  independently versioned toolchain packages.
- Added the local-first `woj` CLI as the single Student and Organizer command-line interface.
  Local commands use only bytes already on the machine and `--offline` rejects every
  network-capable command before dispatch; remote commands authorize through a browser-approved
  device flow and keep the resulting token only in the operating system credential store, with
  no plaintext file fallback. Exit codes 0 through 7 are part of its public contract.
- Removed the `wasm-oj-collection` executable from `@wasm-oj/organizer`. `woj organizer
  collection` replaces it, and the packaged GitHub Action now invokes `@wasm-oj/cli`.
- Added the Java WASI toolchain package built on TeaVM and the OpenJDK class library. Hosts
  install it explicitly like every other toolchain; Java is a compiler capability and is not yet
  a problem submission language.
- Made browser and server toolchain sources explicit and digest-verified; removed implicit
  CDN, directory-search, and compatibility fallback paths.
- Reorganized UI code into reusable primitives and domain feature modules.
- Renamed product-facing APIs, schemas, protocols, binaries, storage identities, and
  operational configuration to WASM-OJ. The GitHub repository path remains unchanged.

## 0.1.0 - 2026-07-19

Initial experimental release of the retired monolithic package.

- Browser and server compiler hosts for C, C++, Rust, Go, Python, JavaScript,
  and TypeScript targeting `wasip1`, with the supported C/C++ `wasix` profile.
- Deterministic Wasmer runner with weighted metering, normalized startup cost,
  virtual clocks and randomness, memory/output/VFS quotas, and replay bundles.
- Multi-file judging, special checkers, interactive judging, dependency locks,
  content-addressed incremental compilation, and unified browser storage.
- Submission-scoped operations, stable errors and observations, browser runtime
  driver plug-ins, and one-line server initialization.
- Cross-host conformance evidence covering 21 language, target, filesystem,
  capability, and deterministic-time cases.
