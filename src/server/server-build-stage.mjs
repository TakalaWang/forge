import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { deserialize, serialize } from "node:v8";
import { buildServerProjectInProcess, disposeServerBuildStage } from "./server-compiler.ts";
import { deserializeServerToolchainSources } from "./toolchain-sources.ts";
import { readBoundedRegularFile } from "./bounded-transport.ts";

const SERVER_BUILD_REQUEST_LIMIT_BYTES = 768 * 1024 * 1024;

process.stdin.once("end", () => process.exit(0));
process.once("SIGTERM", () => {
  disposeServerBuildStage();
  process.exit(1);
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line) continue;
  const { requestPath, responsePath } = parseTransport(line);
  let response;
  try {
    const encoded = deserialize(await readBoundedRegularFile(requestPath, SERVER_BUILD_REQUEST_LIMIT_BYTES));
    const result = await buildServerProjectInProcess(
      {
        compilerExecutable: encoded.compilerExecutable,
        stageDirectory: encoded.stageDirectory,
        toolchains: deserializeServerToolchainSources(encoded.toolchains),
        verifiedToolchain: encoded.verifiedToolchain === true,
      },
      encoded.project,
      encoded.cacheKey,
      (progress) => writeFileSync(3, `${JSON.stringify(progress)}\n`),
    );
    response = { ok: true, result };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(responsePath, serialize(response), { flag: "wx" });
  writeFileSync(3, `${JSON.stringify({ complete: true })}\n`);
}

function parseTransport(line) {
  const value = JSON.parse(line);
  if (
    typeof value?.requestPath !== "string" || !path.isAbsolute(value.requestPath)
    || typeof value.responsePath !== "string" || !path.isAbsolute(value.responsePath)
  ) {
    throw new Error("The isolated server compiler received an invalid transport request.");
  }
  return value;
}
