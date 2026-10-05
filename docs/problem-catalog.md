# Repository problem and contest contract

The repository is the single source of truth for problem content and contest configuration. The
platform synchronizes one exact 40-character Git commit at a time; D1 stores only query projections,
stable series identities, operational credentials, and the active commit pointer.

## Repository layout

The root file is always `wasm-oj.json`:

```json
{
  "schema": "wasm-oj-platform/repository/v1",
  "problems": "collection/problems.json",
  "contests": "collection/contests.json"
}
```

`collection/problems.json` uses `wasm-oj-platform/problems/v1`. Each problem has a stable `slug`,
unique positive `order`, localized `title` and `summary` (`zh-TW` and `en`), `practiceEnabled`, and
exact descriptors for `practiceBundle`, `contestBundle`, and `judgePackage`:

```json
{
  "path": "dist/problems/sum-two.practice.json",
  "bytes": 4096,
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

`collection/contests.json` uses the strict `wasm-oj-platform/contests/v2` schema. A contest declares
its stable `slug`, `status` (`draft`, `published`, or `archived`), title, description, `accessMode`,
and one canonical typed `rules` value. Rules keep the clock, official track, evidence boundary,
per-problem schedule and limits, scoring, checkpoints, and leaderboard policy explicit. The v1
shape and legacy start/end fields are rejected; there is no parser fallback.

The generated repository manifest always contains canonical rules. For example:

```json
{
  "schema": "wasm-oj-platform/contests/v2",
  "contests": [
    {
      "slug": "weekly-1",
      "status": "published",
      "title": "Weekly 1",
      "description": "One-hour score contest",
      "accessMode": "public",
      "rules": {
        "clock": {
          "kind": "global",
          "registrationOpensAt": "2026-09-01T00:00:00Z",
          "registrationClosesAt": "2026-09-07T01:00:00Z",
          "startsAt": "2026-09-07T00:00:00Z",
          "durationSeconds": 3600
        },
        "officialTrack": { "kind": "code", "aiAssist": "allowed" },
        "evidenceAt": "input-admitted",
        "problems": [
          {
            "slug": "sum-two",
            "batch": 1,
            "releaseAfterSeconds": 0,
            "submissionClosesAfterSeconds": 3600,
            "points": 100,
            "attemptLimit": 10
          }
        ],
        "scoring": {
          "kind": "score",
          "tieBreaks": ["fully-passed-cases", "deterministic-cost", "peak-memory", "final-best-achieved-at"]
        },
        "checkpoints": [],
        "leaderboard": { "kind": "live" }
      }
    }
  ]
}
```

Invite codes are credentials: only their D1 HMAC and rotation API exist; the repository never
contains them. A public contest only removes the invite-code requirement. Every official entrant
still joins before starting or submitting.

Manifest JSON must be valid UTF-8 and match the exact schema, but need not use canonical JSON byte
encoding. Paths are normalized repository-relative POSIX paths. Byte length and SHA-256 belong to
the referenced content object and are used for transport verification and content-addressed cache
keys. The Git commit itself is the complete catalog version.

## Authoring

```sh
pnpm exec woj organizer collection init .
pnpm exec woj organizer collection build .
pnpm exec woj organizer collection verify .
```

The optional author-only `collection/source.json` uses
`wasm-oj-platform/repository-authoring/v1`, and its trusted judge declarations use
`wasm-oj-platform/repository-authoring-judges/v1`. `build` derives practice and contest public
projections and a private `WOJJDG02` judge package, then writes the three repository manifests.
`verify` checks those outputs without rewriting them. `--source <path>` selects a different
normalized authoring input.

Authoring input may use `classic-score`, `icpc`, `blitz-batches`, or
`prompt-five-by-three` presets in a contest's `rules`. `build` expands every preset before writing
`collection/contests.json`; presets never survive into repository output or select a special
runtime path. The Issue #24 five-problem/three-attempt behavior is therefore only the
`prompt-five-by-three` preset. Canonical Prompt Program rules may choose a different problem count
and per-problem attempt limits.

A compact authoring preset looks like this:

```json
{
  "slug": "blitz-20",
  "status": "published",
  "title": "Blitz 20",
  "description": "Four new problems every three minutes",
  "accessMode": "public",
  "rules": {
    "preset": "blitz-batches",
    "clock": {
      "kind": "global",
      "registrationOpensAt": "2026-09-01T00:00:00Z",
      "registrationClosesAt": "2026-09-07T00:15:00Z",
      "startsAt": "2026-09-07T00:00:00Z",
      "durationSeconds": 900
    },
    "problemSlugs": ["p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08"],
    "batchSize": 4,
    "releaseIntervalSeconds": 180,
    "pointsPerProblem": 100,
    "attemptLimit": 10,
    "minimumSolvedPerBatch": 2,
    "aiAssist": "allowed",
    "leaderboard": { "kind": "live" }
  }
}
```

Both commands enforce schema, path, size, digest, public/private redaction, public-projection
relationships, supported compile profiles, and deployable judge-package structure. They do not
compile, run, benchmark, score, or assess a reference solution. `allowedProfiles` is carried only
inside the judge package manifest. Judge output remains 0–100; contest `points` performs the
declared weighting.

Repositories can use [`.github/actions/woj/action.yml`](../.github/actions/woj/action.yml) with an
exact `@wasm-oj/cli@0.2.3` package version to run the same static verification in CI.

## Exact-commit synchronization

The remote Organizer journey is:

```sh
woj organizer catalog connect --repo <numeric-repository-id>
woj organizer catalog sync <catalog-id> --ref <branch-tag-or-commit> --wait
woj organizer catalog show <catalog-id>
```

The Catalog Workflow resolves `ref` exactly once. Every later GitHub request uses the resulting
commit SHA. It reads the root, problem, and contest manifests; verifies all referenced objects;
ensures each judge package is present under its content-addressed R2 key; then inserts the query
projection and changes `active_commit_sha` in one D1 transaction. A failed sync leaves the old
active commit untouched. Repeating the same commit is idempotent and still repairs a missing judge
object.

If a public GitHub repository contains staged contest material, scheduling provides UI-timed
reveal only. Participants must see the warning **“UI timing only; GitHub content may be visible early.”**
Neither the repository projection nor the Organizer may claim that unreleased files are secret.

Public content is loaded on demand. The service first checks `public-content/v1/<sha256>` in R2.
On a miss it requests the declared repository path at the exact practice-active commit or the
contest's exact effective `contentCommit`, verifies byte length
and SHA-256, and conditionally fills the cache. A GitHub or R2 failure on a cold cache fails closed;
the service never substitutes a branch head, older commit, or unchecked bytes. The cache interface
is intentionally reusable by a future manual warm command.

Prompt Program context is likewise materialized from the exact public problem projection and
addressed by digest. A published Prompt Program contest may synchronize without a host compiler
adapter. Its projection then reports `promptCompilerAvailable: false`; prompt admission returns
typed `503 prompt-compiler-unavailable` before reserving quota, with no provider fallback.

See [Declarative contest rules](contest-rules.md) for canonical rule fields, Prompt Program,
pause/recalculation/rewind behavior, and the contest v2 cutover contract.

## Browser-local collections

Credential-free GitHub collections used only for local browser practice remain a separate feature.
Their browser bundle schema and cache do not authorize Official Submit and do not participate in
the repository catalog sync described above.
