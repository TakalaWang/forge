import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSdkProject } from "../sdk/project";
import { ReusableStage } from "./reusable-stage";
import { ServerCompiler } from "./server-compiler";
import { serializeServerToolchainSources } from "./toolchain-sources";
import { testToolchains } from "./test-toolchains.test-helper";

const FAKE_STAGE = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.stdin.once("end", () => process.exit(0));
for await (const line of createInterface({ input: process.stdin })) {
  if (line !== "hang") writeFileSync(3, \`\${process.pid}\\n\`);
}
`;

describe("reusable server stage", () => {
  let directory: string;
  let script: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-reusable-stage-"));
    script = path.join(directory, "stage.mjs");
    await writeFile(script, FAKE_STAGE);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const stage = (options: { maxExchanges?: number; idleTimeoutMs?: number } = {}) => new ReusableStage({
    script,
    label: "test",
    lineLimitBytes: 1024,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    ...(options.maxExchanges === undefined ? {} : { maxExchanges: options.maxExchanges }),
  });

  it("serves sequential exchanges from one child and replaces it after the exchange limit", async () => {
    const target = stage({ maxExchanges: 2 });
    try {
      const first = await ask(target);
      expect(await ask(target)).toBe(first);
      await waitForExit(first);
      const third = await ask(target);
      expect(third).not.toBe(first);
      expect(await ask(target)).toBe(third);
    } finally {
      target.terminate();
    }
  });

  it("never reuses a child after a failed, timed-out or terminated exchange", async () => {
    const target = stage();
    try {
      const failed = await ask(target);
      await expect(target.run({
        request: "pid",
        timeoutMs: 10_000,
        timeoutMessage: "The test stage timed out.",
        line: () => true,
        complete: () => {
          throw new Error("Invalid stage response.");
        },
      })).rejects.toThrow("Invalid stage response.");
      await waitForExit(failed);

      const timedOut = await ask(target);
      expect(timedOut).not.toBe(failed);
      await expect(ask(target, "hang", 200)).rejects.toThrow("The test stage timed out.");
      await waitForExit(timedOut);

      const terminated = await ask(target);
      expect(terminated).not.toBe(timedOut);
      const pending = ask(target, "hang");
      target.terminate();
      await expect(pending).rejects.toThrow("The test stage exited before it answered.");
      await waitForExit(terminated);
      expect(await ask(target)).not.toBe(terminated);
    } finally {
      target.terminate();
    }
  });

  it("retires idle children without keeping the owning process alive", async () => {
    const target = stage({ idleTimeoutMs: 100 });
    const idle = await ask(target);
    await waitForExit(idle);

    const moduleUrl = pathToFileURL(path.resolve("src/server/reusable-stage.ts")).href;
    const owner = spawn(process.execPath, [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      `
        import { ReusableStage } from ${JSON.stringify(moduleUrl)};
        const stage = new ReusableStage({ script: ${JSON.stringify(script)}, label: "test", lineLimitBytes: 1024, idleTimeoutMs: 60_000 });
        let pid = "";
        await stage.run({ request: "pid", timeoutMs: 10_000, timeoutMessage: "timed out", line: (line) => { pid = line; return true; }, complete: () => undefined });
        process.stdout.write(pid);
      `,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    owner.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    const started = Date.now();
    const code = await new Promise((resolve) => owner.once("close", resolve));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    await waitForExit(Number(stdout));
  });
});

describe("server stage children", () => {
  const rust = (value: number) => createSdkProject({
    language: "rust",
    entry: "src/main.rs",
    files: { "src/main.rs": `fn main(){ println!("{}", ${value}); }\n` },
  });

  it("reuses the build child, replaces the rustc child after its build limit and discards cancelled children", { timeout: 300_000 }, async () => {
    const existing = new Set(descendants(process.pid).map((child) => child.pid));
    const stages = (name: string) => descendants(process.pid)
      .filter((child) => !existing.has(child.pid) && child.command.includes(name))
      .map((child) => child.pid);
    const compiler = new ServerCompiler({ compilerExecutable: process.execPath, toolchains: testToolchains() });
    const build = async (value: number) => {
      const result = await compiler.build(rust(value), `rust-${value}`);
      expect(result.success, result.stderr).toBe(true);
    };
    try {
      await build(1);
      const [buildStage] = stages("server-build-stage.mjs");
      const [rustc] = stages("rustc-stage.mjs");
      expect(buildStage).toBeDefined();
      expect(rustc).toBeDefined();

      await build(2);
      await waitForExit(rustc!);
      expect(stages("rustc-stage.mjs")).toEqual([]);

      await build(3);
      expect(stages("server-build-stage.mjs")).toEqual([buildStage]);
      const [replacement] = stages("rustc-stage.mjs");
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(rustc);

      const compiling = new Promise<void>((resolve) => {
        const remove = compiler.onProgress((progress) => {
          if (progress.phase !== "compiling") return;
          remove();
          resolve();
        });
      });
      const cancelled = compiler.build(rust(4), "rust-4");
      cancelled.catch(() => undefined);
      await compiling;
      compiler.cancel();
      await expect(cancelled).rejects.toThrow("cancelled");
      await waitForExit(buildStage!);
      await waitForExit(replacement!);

      await build(5);
      const [next] = stages("server-build-stage.mjs");
      expect(next).toBeDefined();
      expect(next).not.toBe(buildStage);
    } finally {
      compiler.dispose();
    }
  });

  it.each(["idle", "busy"])("exits %s build and rustc children when their owner dies", { timeout: 300_000 }, async (state) => {
    const transport = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-stage-orphan-"));
    try {
      const requestPath = path.join(transport, "request.v8");
      await writeFile(requestPath, serialize({
        compilerExecutable: process.execPath,
        stageDirectory: path.resolve("src/server"),
        toolchains: serializeServerToolchainSources(testToolchains()),
        verifiedToolchain: false,
        project: rust(42),
        cacheKey: "orphan",
      }));
      const owner = spawn(process.execPath, [
        "--input-type=module",
        "--eval",
        `
          import { spawn } from "node:child_process";
          const stage = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", ${JSON.stringify(path.resolve("src/server/server-build-stage.mjs"))}], { stdio: ["pipe", "ignore", "ignore", "pipe"] });
          stage.stdio[3].on("data", (chunk) => {
            if (String(chunk).includes('"complete":true')) process.stdout.write("complete\\n");
          });
          stage.stdin.write(${JSON.stringify(JSON.stringify({ requestPath, responsePath: path.join(transport, "response.v8") }))} + "\\n");
          process.stdout.write(\`\${stage.pid}\\n\`);
          setInterval(() => undefined, 60_000);
        `,
      ], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      owner.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
      try {
        await waitFor(() => (state === "idle"
          ? stdout.includes("complete\n")
          : descendants(owner.pid!).some((child) => child.command.includes("rustc-stage.mjs"))));
        const children = descendants(owner.pid!).filter((child) => child.command.includes("-stage.mjs"));
        expect(children.map((child) => path.basename(child.command.split(" ").at(-1)!)).sort())
          .toEqual(["rustc-stage.mjs", "server-build-stage.mjs"]);
        owner.kill("SIGKILL");
        for (const child of children) await waitForExit(child.pid);
      } finally {
        owner.kill("SIGKILL");
      }
    } finally {
      await rm(transport, { recursive: true, force: true });
    }
  });
});

function ask(stage: ReusableStage, request = "pid", timeoutMs = 10_000): Promise<number> {
  let pid = 0;
  return stage.run({
    request,
    timeoutMs,
    timeoutMessage: "The test stage timed out.",
    line: (line) => {
      pid = Number(line);
      return true;
    },
    complete: () => pid,
  });
}

function descendants(root: number): Array<{ pid: number; command: string }> {
  const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((row) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
    });
  const found: Array<{ pid: number; command: string }> = [];
  const parents = [root];
  while (parents.length > 0) {
    const parent = parents.pop();
    for (const child of processes.filter((entry) => entry.parent === parent)) {
      found.push({ pid: child.pid, command: child.command });
      parents.push(child.pid);
    }
  }
  return found;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => !running(pid), timeoutMs, `Process ${pid} did not exit within ${timeoutMs} ms.`);
}

async function waitFor(condition: () => boolean, timeoutMs = 120_000, message = "Condition was not met."): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
