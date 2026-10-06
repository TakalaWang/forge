import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPnpmLock, requireLockedPackage } from "./pnpm-lock.mjs";
import { wasmerSdkRuntimeFiles } from "./wasmer-sdk-runtime.mjs";

const EXPECTED_VERSION = "0.19.0";
const EXPECTED_INTEGRITY = "sha512-4gdWiIlne8ti3dQl1yD6jrLLNKrQXmZXA6iy6ta/6sgYpixPLwymeGqhMzjAIHqhmwrD+SjPFpZ5ugd9SytDrQ==";
const EXPECTED_FILES = Object.freeze({
  "dist/browser-worker.js": "775223c87ff60c22515e88945e1152c02f7bfa49898edab748e89e573ec4d439",
  "dist/index.js": "8a4753fcc7bda778da38a9f3e8ecfaae52497e0756f8a1f06da9f87a2ecf2c11",
  "dist/node.js": "0a917fce4d5b22e8d39d746e9c2ae0a37715802d712e6f0f67486919b237412c",
  "pkg/wasmer_sdk_js.js": "b8f330f47fcbc48541af65985b2db63116f220231a3225e9ec347c5f74dcfa35",
  "pkg/wasmer_sdk_js_bg.wasm": "86aefc8940d29045f94646421bec6fac528a736aa4e78718fdb7924897ee4c25",
  "package.json": "19570be326d74717571202df1a0b8998d991e07e5bafb77655eca78bdc99cf24",
});
const EXPECTED_SOURCE_REVISION = "7e69332b7f65dbc5584d64bb79f547eaf4302b69";
const EXPECTED_CARGO_LOCK_SHA256 = "34156a76319127aa4152e8b25bd92a5657f7ddc0669ba3e26209cc57053f56a1";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readPnpmLock(root);
const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@wasmer/sdk/browser"))));
const sdkPackagePath = path.join(sdkRoot, "package.json");
const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
const licenseInventoryPath = path.join(root, "licenses/wasmer-sdk-dependencies.json");
const licenseReportPath = path.join(root, "licenses/wasmer-sdk-dependencies.html");
const [licenseInventoryBytes, licenseReportBytes] = await Promise.all([
  readFile(licenseInventoryPath),
  readFile(licenseReportPath),
]);
const licenseInventory = JSON.parse(licenseInventoryBytes.toString("utf8"));

if (rootPackage.dependencies?.["@wasmer/sdk"] !== EXPECTED_VERSION) {
  throw new Error(`WASM-OJ must pin @wasmer/sdk exactly to ${EXPECTED_VERSION}.`);
}
if (sdkPackage.name !== "@wasmer/sdk" || sdkPackage.version !== EXPECTED_VERSION) {
  throw new Error(
    `Expected the official @wasmer/sdk ${EXPECTED_VERSION} package, received `
    + `${String(sdkPackage.name)} ${String(sdkPackage.version)}.`,
  );
}

const lockedSdk = requireLockedPackage(lock, "@wasmer/sdk", EXPECTED_VERSION);
if (lockedSdk.integrity !== EXPECTED_INTEGRITY) {
  throw new Error(`pnpm-lock.yaml does not bind the official @wasmer/sdk ${EXPECTED_VERSION} tarball.`);
}

for (const [relative, expected] of Object.entries(EXPECTED_FILES)) {
  const actual = createHash("sha256")
    .update(await readFile(path.join(sdkRoot, relative)))
    .digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Installed @wasmer/sdk file '${relative}' differs from the official ${EXPECTED_VERSION} package: `
      + `expected ${expected}, received ${actual}.`,
    );
  }
}

if (
  licenseInventory.schema !== "wasm-oj-v2/wasmer-sdk-licenses"
  || licenseInventory.generator?.name !== "cargo-about"
  || licenseInventory.generator?.version !== "0.9.1"
  || licenseInventory.graph?.package !== `@wasmer/sdk@${EXPECTED_VERSION}`
  || licenseInventory.graph?.sourceRevision !== EXPECTED_SOURCE_REVISION
  || licenseInventory.graph?.cargoLockSha256 !== EXPECTED_CARGO_LOCK_SHA256
  || licenseInventory.graph?.target !== "wasm32-unknown-unknown"
  || licenseInventory.graph?.defaultFeatures !== true
  || JSON.stringify(licenseInventory.graph?.features) !== "[]"
  || JSON.stringify(licenseInventory.graph?.dependencyKinds) !== '["normal"]'
) {
  throw new Error("The Wasmer SDK license inventory does not describe the pinned browser Wasm dependency graph.");
}
const reportSha256 = createHash("sha256").update(licenseReportBytes).digest("hex");
if (
  licenseInventory.report?.path !== "licenses/wasmer-sdk-dependencies.html"
  || licenseInventory.report?.sha256 !== reportSha256
) {
  throw new Error("The Wasmer SDK license inventory does not bind its distributed HTML report.");
}
const packageIdentities = new Set();
for (const item of licenseInventory.packages ?? []) {
  if (
    typeof item?.name !== "string"
    || typeof item.version !== "string"
    || (item.repository !== null && typeof item.repository !== "string")
    || !Array.isArray(item.selectedLicenses)
    || item.selectedLicenses.length === 0
    || item.selectedLicenses.some((license) => typeof license !== "string" || !license)
  ) {
    throw new Error("The Wasmer SDK license inventory contains an invalid package record.");
  }
  const identity = `${item.name}@${item.version}`;
  if (packageIdentities.has(identity)) throw new Error(`Duplicate Wasmer SDK license package '${identity}'.`);
  packageIdentities.add(identity);
  if (!licenseReportBytes.includes(Buffer.from(`${item.name} ${item.version}`))) {
    throw new Error(`The Wasmer SDK HTML license report omits '${identity}'.`);
  }
}
if (packageIdentities.size < 300 || licenseReportBytes.byteLength < 100_000) {
  throw new Error("The Wasmer SDK dependency license closure is unexpectedly incomplete.");
}

const runtimeFiles = await wasmerSdkRuntimeFiles();
for (const relative of ["dist/index.js", "dist/browser-worker.js", "pkg/wasmer_sdk_js.js", "pkg/wasmer_sdk_js_bg.wasm"]) {
  if (!runtimeFiles.has(relative)) throw new Error(`The shipped Wasmer SDK runtime omits '${relative}'.`);
}
if ([...runtimeFiles.keys()].some((relative) => relative.includes("wisp"))) {
  throw new Error("The shipped Wasmer SDK runtime must not include the WISP networking module.");
}

const { Wasmer } = await import("@wasmer/sdk/node");
const wasmer = await new Wasmer({ cache: false }).ready();
if (!(wasmer instanceof Wasmer)) throw new Error("The official Wasmer SDK did not construct a client.");

process.stdout.write(
  `Verified official @wasmer/sdk ${EXPECTED_VERSION} integrity, shipped runtime files, and client initialization.\n`,
);
process.exit(0);
