/// <reference types="vite/client" />

declare module "virtual:wasm-oj/wasmer-sdk" {
  /** URL of the shipped `@wasmer/sdk` browser entry module. */
  export const wasmerSdkEntryUrl: string;
  /** URL of the SDK's wasm-bindgen module, which owns its Worker URL setting. */
  export const wasmerSdkBindingUrl: string;
}
