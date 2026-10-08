import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const WASM_OJ_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "0ae00fc646f529aafb5d1a68758220e6428f6c565e8e621eeb6c8f14ac5d4a10",
  runtimeSourceRootSha256: "a7e9071511d127e3b14920558c7c38c27a1fa19d98906c8476c1df8041a9c3bb",
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
  "e5680beae9bd832ed2b679267250ce1efc7d104dd005bb155135664b40f961fb";

/** Exact canonical serialization hashed by `WASM_OJ_RUNTIME_IDENTITY_SHA256`. */
export function runtimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(WASM_OJ_RUNTIME_COMPONENTS);
}

export async function verifyRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(runtimeIdentityBytes()) !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("WASM-OJ runtime identity declaration does not match its digest.");
  }
}
