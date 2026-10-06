import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const WASM_OJ_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "1e297ad276694e9fb8a23afdc6ccc0b2ae56a223ced19d5cae26fe4661daa11e",
  runtimeSourceRootSha256: "27c52cb1887aa8a7e0d8a238514fc8881cf86c68267e2a1691f110423692e2b6",
  wasmerNativeVersion: "7.2.1",
  wasmerSdkVersion: "0.19.0",
  wasmerSdkWasmSha256: "86aefc8940d29045f94646421bec6fac528a736aa4e78718fdb7924897ee4c25",
  wasmerWasixVersion: "0.702.1",
} as const);

/**
 * SHA-256 of `runtimeIdentityBytes()`.
 * Release verification independently checks the component bytes before this
 * identity is admitted into a calibrated release.
 */
export const WASM_OJ_RUNTIME_IDENTITY_SHA256 =
  "4b7a0a876d97c53675bc9b1a5a1d5da8a07e632b9cdafc2f775ab65efd9d2ae2";

/** Exact canonical serialization hashed by `WASM_OJ_RUNTIME_IDENTITY_SHA256`. */
export function runtimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(WASM_OJ_RUNTIME_COMPONENTS);
}

export async function verifyRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(runtimeIdentityBytes()) !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("WASM-OJ runtime identity declaration does not match its digest.");
  }
}
