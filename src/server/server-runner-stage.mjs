import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { Wasmer } from "@wasmer/sdk/node";
import { withProcessKeepalive } from "./process-keepalive.mjs";
import {
  PYTHON_COMMAND_SHA256,
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_SHA256,
} from "../core/toolchains.ts";
import { readWebcAtom } from "../runner/webc.ts";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_CHARACTERS = 64 * 1024;

let response;
let exitCode = 0;

try {
  const input = parseInput(JSON.parse(await readStdin()));
  const packagePath = input.toolchainAsset;
  const compressed = await readFile(packagePath);
  if (!input.verifiedToolchain) verifyDigest(packagePath, compressed, PYTHON_COMPRESSED_PACKAGE_SHA256);
  const expanded = uint8View(gunzipSync(compressed));
  if (!input.verifiedToolchain) verifyDigest(packagePath, expanded, PYTHON_PACKAGE_SHA256);

  let bytes;
  if (input.request.operation === "command-binary") {
    bytes = readWebcAtom(expanded, input.request.command).slice();
    verifyDigest(`${input.request.packageSpecifier} command '${input.request.command}'`, bytes, PYTHON_COMMAND_SHA256);
  } else {
    const wasmer = new Wasmer({ cache: false, outputBytes: MAX_RESULT_BYTES });
    const pkg = await withProcessKeepalive(wasmer.packages.load(expanded));
    const sandbox = await withProcessKeepalive(wasmer.sandboxes.create({
      packages: [pkg],
      env: {
        PYTHONHOME: "/usr/local",
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    }));
    const output = await withProcessKeepalive(
      sandbox.command(input.request.command, input.request.args).run({ check: false }),
    );
    if (!output.ok || output.stdout.truncated) {
      throw new Error(
        `Unable to export runtime files from ${input.request.packageSpecifier}: `
        + `${output.reason} ${output.exitCode}: ${boundedText(output.stderr.text())}`,
      );
    }
    bytes = output.stdout.bytes;
  }

  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error(
      `Runner stage result is ${bytes.byteLength} bytes; the limit is ${MAX_RESULT_BYTES} bytes.`,
    );
  }
  response = {
    ok: true,
    result: { operation: input.request.operation, bytes },
  };
} catch (error) {
  response = { ok: false, error: boundedText(error instanceof Error ? error.message : String(error)) };
  exitCode = 1;
} finally {
  try {
    writeFileSync(requiredResponsePath(), serialize(response), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(`Unable to write the runner-stage response: ${errorText(error)}\n`);
    exitCode = 1;
  }
  setTimeout(() => process.exit(exitCode), 10);
}

function parseInput(value) {
  if (!isRecord(value) || typeof value.toolchainAsset !== "string"
    || !path.isAbsolute(value.toolchainAsset) || !isRecord(value.request)) {
    throw new Error("The runner stage received an invalid request envelope.");
  }
  const request = value.request;
  if (
    request.packageSpecifier !== PYTHON_PACKAGE
    || request.command !== "python"
    || (request.operation !== "command-binary" && request.operation !== "runtime-files")
  ) {
    throw new Error("The runner stage request does not name a pinned WASM-OJ runtime command.");
  }
  if (
    request.operation === "runtime-files"
    && (!Array.isArray(request.args) || request.args.some((argument) => typeof argument !== "string"))
  ) {
    throw new Error("The runner stage runtime-files arguments are invalid.");
  }
  return {
    toolchainAsset: value.toolchainAsset,
    verifiedToolchain: value.verifiedToolchain === true,
    request: request.operation === "command-binary"
      ? {
          operation: request.operation,
          packageSpecifier: request.packageSpecifier,
          command: request.command,
        }
      : {
          operation: request.operation,
          packageSpecifier: request.packageSpecifier,
          command: request.command,
          args: [...request.args],
        },
  };
}

function verifyDigest(filename, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned package '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

function uint8View(bytes) {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requiredResponsePath() {
  const value = process.env.WASM_OJ_RUNNER_STAGE_RESPONSE;
  if (!value) throw new Error("WASM_OJ_RUNNER_STAGE_RESPONSE is required.");
  return value;
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(`Runner stage input exceeds ${MAX_INPUT_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function boundedText(value) {
  const text = String(value);
  return text.length <= MAX_ERROR_CHARACTERS
    ? text
    : `${text.slice(0, MAX_ERROR_CHARACTERS)}…`;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
