import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildArtifact } from "../core/types";
import { createEngine, type Engine } from "../sdk/engine";
import type { CompileInput } from "../sdk/project";
import { ServerCompiler } from "./server-compiler";
import { ServerRunner } from "./server-runner";
import { testToolchains } from "./test-toolchains.test-helper";

const enabled = process.env.WASM_OJ_RUN_CANCELLATION_STRESS === "1";
const rounds = Number(process.env.WASM_OJ_CANCELLATION_ROUNDS ?? "4");
const SETTLE_LIMIT_MS = 60_000;
const ENTRIES: Readonly<Record<string, string>> = { c: "main.c", cpp: "main.cpp", rust: "main.rs", python: "main.py" };

// Cancels every server path that runs a guest mid-flight: SDK compiler
// children, the SDK Python runtime-preparation child, and native runner
// processes. Cancellation must settle promptly and leave the engine usable.
describe.skipIf(!enabled)("server cancellation stress", () => {
  let scratch: string;
  let engine: Engine;
  let cpuLoop: BuildArtifact;
  let outputHeavy: BuildArtifact;

  const createServerEngine = (cacheDirectory: string) => createEngine({
    compiler: new ServerCompiler({
      compilerExecutable: path.resolve("crates/runtime-core/target/release/wasm-oj-compiler"),
      toolchains: testToolchains(),
    }),
    runner: new ServerRunner({
      runtimeExecutable: path.resolve("crates/runtime-core/target/release/wasm-oj-runner"),
      toolchains: testToolchains(),
      cacheDirectory,
    }),
  });

  beforeAll(async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release",
      "--bin", "wasm-oj-runner", "--bin", "wasm-oj-compiler",
    ], { stdio: "pipe" });
    scratch = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-cancellation-"));
    engine = await createServerEngine(path.join(scratch, "shared"));
    cpuLoop = await compile(engine, "c", "int main(void){volatile unsigned long long x=0;for(;;)x++;}\n");
    outputHeavy = await compile(
      engine,
      "c",
      "#include <stdio.h>\nint main(void){for(unsigned long i=0;;i++)printf(\"%lu xxxxxxxxxxxxxxxxxxxxxxxx\\n\",i);}\n",
    );
  }, 300_000);

  afterAll(async () => {
    engine?.dispose();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("settles every cancelled operation and keeps the engine usable", { timeout: 1_800_000 }, async () => {
    const scenarios: Array<{ name: string; delay: [number, number]; fresh?: boolean; start(target: Engine): Promise<unknown> }> = [
      {
        name: "C++ compile",
        delay: [100, 2_500],
        start: (target) => target.compile(input("cpp", "#include <iostream>\n#include <map>\nint main(){std::map<int,int> m; m[1]=2; std::cout<<m.size()<<\"\\n\";}\n"), { cache: false }),
      },
      {
        name: "Rust compile",
        delay: [200, 4_000],
        start: (target) => target.compile(input("rust", "fn main(){ let v: Vec<u64> = (0..64).collect(); println!(\"{}\", v.len()); }\n"), { cache: false }),
      },
      {
        name: "Python runtime preparation",
        delay: [100, 2_000],
        fresh: true,
        start: async (target) => target.run(await compile(target, "python", "print(41 + 1)\n")),
      },
      { name: "CPU-bound run", delay: [50, 1_500], start: (target) => target.run(cpuLoop) },
      {
        name: "output-heavy run",
        delay: [50, 1_500],
        start: (target) => target.run(outputHeavy, { resources: { outputLimitBytes: 64 * 1024 * 1024 } }),
      },
    ];
    for (let round = 0; round < rounds; round += 1) {
      for (const scenario of scenarios) {
        const target = scenario.fresh ? await createServerEngine(path.join(scratch, `fresh-${round}`)) : engine;
        try {
          const delay = scenario.delay[0] + Math.floor(Math.random() * (scenario.delay[1] - scenario.delay[0]));
          const timer = setTimeout(() => target.cancel(), delay);
          const settled = await Promise.race([
            scenario.start(target).then(() => "completed", () => "cancelled"),
            new Promise((resolve) => setTimeout(() => resolve("hung"), SETTLE_LIMIT_MS)),
          ]);
          clearTimeout(timer);
          expect(settled, `${scenario.name} cancelled after ${delay} ms`).not.toBe("hung");

          const run = await target.run(await compile(target, "c", "#include <stdio.h>\nint main(void){printf(\"%d\\n\", 40 + 2);return 0;}\n"));
          expect(run).toMatchObject({ code: 0, stdout: "42\n", termination: "exited" });
          if (scenario.fresh) {
            const python = await target.run(await compile(target, "python", "print(40 + 2)\n"));
            expect(python).toMatchObject({ code: 0, stdout: "42\n", termination: "exited" });
          }
        } finally {
          if (target !== engine) target.dispose();
        }
      }
    }
  });
});

function input(language: CompileInput["language"], source: string): CompileInput {
  const entry = ENTRIES[language]!;
  return {
    projectId: `cancellation:${language}:${Math.random()}`,
    language,
    target: "wasip1",
    optimization: "release",
    entry,
    files: { [entry]: source },
  };
}

async function compile(engine: Engine, language: CompileInput["language"], source: string): Promise<BuildArtifact> {
  const result = await engine.compile(input(language, source), { cache: false });
  if (!result.success || !result.artifact) throw new Error(`Failed to compile ${language}: ${result.stderr}`);
  return result.artifact;
}
