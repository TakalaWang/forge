import { publishCargoLicenseInventory } from "./cargo-license-inventory.mjs";

const [rawPath, stagedReportPath, reportPath, inventoryPath] = process.argv.slice(2);
if (!rawPath || !stagedReportPath || !reportPath || !inventoryPath || process.argv.length !== 6) {
  throw new Error(
    "Usage: node scripts/compact-wasmer-sdk-license-report.mjs "
    + "<cargo-about.json> <staged-report.html> <report.html> <inventory.json>",
  );
}

await publishCargoLicenseInventory({
  rawPath,
  stagedReportPath,
  reportPath,
  inventoryPath,
  schema: "wasm-oj-v2/wasmer-sdk-licenses",
  graph: {
    package: "@wasmer/sdk@0.19.0",
    sourceRevision: "7e69332b7f65dbc5584d64bb79f547eaf4302b69",
    cargoLockSha256: "34156a76319127aa4152e8b25bd92a5657f7ddc0669ba3e26209cc57053f56a1",
    target: "wasm32-unknown-unknown",
    defaultFeatures: true,
    features: [],
    dependencyKinds: ["normal"],
  },
  reportRelativePath: "licenses/wasmer-sdk-dependencies.html",
});
