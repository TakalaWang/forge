import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const WASM_OJ_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "323189cea65215555af54b0d696ad18bf7b265f7dd357de15dee9e71f5d1e88c",
  runtimeSourceRootSha256: "a4bacdaa371de8277e777f98c2fd99f86c8068cbed301ca1ed12678925fe1f47",
  wasmerNativeVersion: "7.2.1",
  wasmerSdkVersion: "0.10.0",
  wasmerSdkWasmSha256: "49a6646209f5ab5e7c737eac33407d87d9a9959ac83e5ecaaab9261b2323589e",
  wasmerWasixVersion: "0.702.1",
} as const);

/**
 * SHA-256 of `runtimeIdentityBytes()`.
 * Release verification independently checks the component bytes before this
 * identity is admitted into a calibrated release.
 */
export const WASM_OJ_RUNTIME_IDENTITY_SHA256 =
  "e12c2290e2ec27f3fc6b2fa664b4ec691a5cdf0e0563763da223f0e0468db9b3";

/** Exact canonical serialization hashed by `WASM_OJ_RUNTIME_IDENTITY_SHA256`. */
export function runtimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(WASM_OJ_RUNTIME_COMPONENTS);
}

export async function verifyRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(runtimeIdentityBytes()) !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("WASM-OJ runtime identity declaration does not match its digest.");
  }
}
