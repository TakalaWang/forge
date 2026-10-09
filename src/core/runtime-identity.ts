import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const WASM_OJ_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "077aa936a3382a242eee7222fc17369769cb5ad265303d730ffc45ee192367e9",
  runtimeSourceRootSha256: "c65b3bbcad41359f86b8f1d1315af8f079b44f0e9084ace0d6d50c0ec418415b",
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
  "47684bee57aafd163b18a787fa16eed33cab3ec3c0005c3c46bb4f1803ffc835";

/** Exact canonical serialization hashed by `WASM_OJ_RUNTIME_IDENTITY_SHA256`. */
export function runtimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(WASM_OJ_RUNTIME_COMPONENTS);
}

export async function verifyRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(runtimeIdentityBytes()) !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("WASM-OJ runtime identity declaration does not match its digest.");
  }
}
