import { canonicalJsonBytes } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/** Executable runtime components covered by deterministic cost calibration. */
export const WASM_OJ_RUNTIME_COMPONENTS = Object.freeze({
  runtimeCoreWasmSha256: "96876c8c384b4c6489088302d2d5e9db91464fa171d0665e0e8009fb96fb9105",
  runtimeSourceRootSha256: "da89f4eef0d1155e7eebeb0f0ee1d6b598e81c4d2ed2b784b299bf9181c38a72",
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
  "07d2d2bf91666336edb4cff570013c32d876307eda523f98545df67ee508805a";

/** Exact canonical serialization hashed by `WASM_OJ_RUNTIME_IDENTITY_SHA256`. */
export function runtimeIdentityBytes(): Uint8Array {
  return canonicalJsonBytes(WASM_OJ_RUNTIME_COMPONENTS);
}

export async function verifyRuntimeIdentity(): Promise<void> {
  if (await sha256Hex(runtimeIdentityBytes()) !== WASM_OJ_RUNTIME_IDENTITY_SHA256) {
    throw new Error("WASM-OJ runtime identity declaration does not match its digest.");
  }
}
