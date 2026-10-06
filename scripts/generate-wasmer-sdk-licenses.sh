#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_ABOUT="${CARGO_ABOUT:-cargo-about}"
EXPECTED_ABOUT_VERSION="cargo-about 0.9.1"
RUST_TOOLCHAIN="1.97.1"
SOURCE_REVISION="7e69332b7f65dbc5584d64bb79f547eaf4302b69"
SOURCE_REPOSITORY="https://github.com/wasmerio/wasmer-sdk.git"
EXPECTED_LOCK_SHA256="34156a76319127aa4152e8b25bd92a5657f7ddc0669ba3e26209cc57053f56a1"

if ! command -v "$CARGO_ABOUT" >/dev/null 2>&1; then
  echo "cargo-about 0.9.1 is required. Install it with:" >&2
  echo "cargo install --locked cargo-about --version 0.9.1 --features cli" >&2
  exit 1
fi
if [[ "$("$CARGO_ABOUT" --version)" != "$EXPECTED_ABOUT_VERSION" ]]; then
  echo "Expected '$EXPECTED_ABOUT_VERSION'." >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wasm-oj-wasmer-sdk-licenses.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
git clone --filter=blob:none --no-checkout "$SOURCE_REPOSITORY" "$WORK/source"
git -C "$WORK/source" checkout --detach "$SOURCE_REVISION"
if [[ "$(git -C "$WORK/source" rev-parse HEAD)" != "$SOURCE_REVISION" ]]; then
  echo "Wasmer SDK source checkout does not match the pinned revision." >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$WORK/source/Cargo.lock" | awk '{print $1}')" != "$EXPECTED_LOCK_SHA256" ]]; then
  echo "Wasmer SDK Cargo.lock does not match the pinned digest." >&2
  exit 1
fi

RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN" cargo fetch \
  --locked \
  --manifest-path "$WORK/source/Cargo.toml"

COMMON=(
  generate
  --config "$ROOT/scripts/wasmer-sdk-about.toml"
  --manifest-path "$WORK/source/js/bindgen/Cargo.toml"
  --locked
  --offline
  --target wasm32-unknown-unknown
  --fail
)
RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN" "$CARGO_ABOUT" "${COMMON[@]}" \
  --output-file "$WORK/report.html" \
  "$ROOT/scripts/wasmer-sdk-licenses.hbs"
RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN" "$CARGO_ABOUT" "${COMMON[@]}" \
  --format json \
  --output-file "$WORK/report.json"
node "$ROOT/scripts/compact-wasmer-sdk-license-report.mjs" \
  "$WORK/report.json" \
  "$WORK/report.html" \
  "$ROOT/licenses/wasmer-sdk-dependencies.html" \
  "$ROOT/licenses/wasmer-sdk-dependencies.json"
