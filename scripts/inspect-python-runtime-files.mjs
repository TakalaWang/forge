import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Wasmer } from "@wasmer/sdk/node";
import {
  PYTHON_RUNTIME_FILES_EXPORT_SCRIPT,
  decodeRuntimeFiles,
} from "../src/runner/runtime-files.ts";

if (process.argv.length !== 3) {
  throw new Error("Usage: node scripts/inspect-python-runtime-files.mjs PACKAGE.webc.gz.bin");
}

const packagePath = path.resolve(process.argv[2]);
let exitCode = 0;

try {
  const packageBytes = gunzipSync(await readFile(packagePath));
  const wasmer = new Wasmer({ cache: false, outputBytes: 256 * 1024 * 1024 });
  const pkg = await wasmer.packages.load(new Uint8Array(packageBytes));
  if (!pkg.commands.includes("python")) throw new Error(`Python package '${packagePath}' does not expose python.`);
  const sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
  const output = await runPython(sandbox, `${String.raw`
import hashlib
import importlib.util
import json
import sys
import sysconfig

sys.stderr.write("WASM_OJ_SMOKE:" + json.dumps({
    "absSrcdir": sysconfig.get_config_var("abs_srcdir"),
    "compiled": bool(compile("value = 6 * 7", "<wasm-oj-smoke>", "exec")),
    "sha256": hashlib.sha256(b"wasm-oj").hexdigest(),
    "socketBuiltin": "_socket" in sys.builtin_module_names,
    "socketSpec": importlib.util.find_spec("_socket") is not None,
    "socketState": sysconfig.get_config_var("MODULE__SOCKET_STATE"),
    "sysPlatform": sys.platform,
    "version": list(sys.version_info[:3]),
}, sort_keys=True, separators=(",", ":")) + "\n")
`}
${PYTHON_RUNTIME_FILES_EXPORT_SCRIPT}`);
  const smokeLine = output.stderr.text().split("\n").find((line) => line.startsWith("WASM_OJ_SMOKE:"));
  if (!smokeLine) throw new Error(`Python runtime smoke emitted no result: ${output.stderr}`);
  const smoke = JSON.parse(smokeLine.slice("WASM_OJ_SMOKE:".length));
  const expectedSmoke = {
    absSrcdir: "/usr/src/cpython-3.14.7",
    compiled: true,
    sha256: "1425f8c83525231bcc1710131e927c852ed3a6950c1cf1578d0a3d52bef7c4b2",
    socketBuiltin: false,
    socketSpec: false,
    socketState: "n/a",
    sysPlatform: "wasi",
    version: [3, 14, 7],
  };
  if (JSON.stringify(smoke) !== JSON.stringify(expectedSmoke)) {
    throw new Error(`Python runtime smoke mismatch: ${JSON.stringify(smoke)}.`);
  }
  const archive = output.stdout.bytes;
  const files = decodeRuntimeFiles(archive);
  process.stdout.write(`WASM_OJ_PYTHON_INSPECTION:${JSON.stringify({
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.byteLength,
    smoke,
    files: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, contents.byteLength]),
    ),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  setTimeout(() => process.exit(exitCode), 50);
}

async function runPython(sandbox, script) {
  const keepAlive = setInterval(() => {}, 1_000);
  let output;
  try {
    output = await sandbox.command("python", ["-c", script], {
      env: {
        PYTHONHOME: "/usr/local",
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    }).run({ check: false });
  } finally {
    clearInterval(keepAlive);
  }
  if (!output.ok) {
    throw new Error(`Python command failed with ${output.reason} ${output.exitCode}: ${output.stderr.text()}`);
  }
  return output;
}
