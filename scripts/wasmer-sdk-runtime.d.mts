import type { Plugin } from "vite";

export declare const WASMER_SDK_VIRTUAL_MODULE: "virtual:wasm-oj/wasmer-sdk";
export declare function wasmerSdkRuntimeFiles(): Promise<Map<string, Buffer>>;
export declare function wasmerSdkRuntime(): Plugin;
