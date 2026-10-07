import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WASM_OJ_CONTRACT_VERSION } from "../core/contract";
import type { BuildArtifact } from "../core/types";
import type { TrustedJudgeProgram } from "../online-judge/trusted-judge-wasm";
import { wasmCheckerMatcher } from "../judge/spec";
import { createEngine, type Engine } from "../sdk/engine";
import type { CompileInput } from "../sdk/project";
import { ServerCompiler } from "./server-compiler";
import { ServerRunner } from "./server-runner";
import { testToolchains } from "./test-toolchains.test-helper";

const enabled = process.env.WASM_OJ_RUN_JUDGE_INTEGRATION === "1";

describe.skipIf(!enabled)("real server judge contracts", () => {
  let engine: Engine;
  let cacheDirectory: string;

  beforeAll(async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release",
      "--bin", "wasm-oj-runner", "--bin", "wasm-oj-compiler",
    ], { stdio: "pipe" });
    cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-judge-integration-"));
    engine = await createEngine({
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
  }, 300_000);

  afterAll(async () => {
    engine?.dispose();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  });

  it("runs a compiled Wasm checker inside Runner", { timeout: 300_000 }, async () => {
    const candidate = await compileC("candidate", [
        "#include <stdio.h>",
        "int main(void) {",
        "  int left = 0, right = 0;",
        "  if (scanf(\"%d %d\", &left, &right) != 2) return 2;",
        "  printf(\"%d\\n\", left + right);",
        "  return 0;",
        "}",
      ].join("\n"));
    const checker = await compileC("checker", [
        "#include <stdio.h>",
        "int main(int argc, char **argv) {",
        "  if (argc < 4) return 2;",
        "  FILE *expected_file = fopen(argv[2], \"r\");",
        "  FILE *actual_file = fopen(argv[3], \"r\");",
        "  if (!expected_file || !actual_file) return 2;",
        "  int expected = 0, actual = 0;",
        "  if (fscanf(expected_file, \"%d\", &expected) != 1) return 2;",
        "  if (fscanf(actual_file, \"%d\", &actual) != 1) return 1;",
        "  return expected == actual ? 0 : 1;",
        "}",
      ].join("\n"));

    const result = await engine.judge(candidate, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "compiled-checker",
        input: { kind: "inline", value: "40 2\n" },
        matcher: wasmCheckerMatcher(asTrustedJudge(checker), "42\n"),
      }],
    });

    expect(result.verdict).toBe("accepted");
    expect(result.cases[0]?.run?.stdout).toBe("42\n");
  });

  it("keeps secrets on the interactor side of a full-duplex session", { timeout: 300_000 }, async () => {
    const contestant = await compileC("contestant", [
        "#include <stdio.h>",
        "int main(void) {",
        "  int challenge = 0;",
        "  if (scanf(\"%d\", &challenge) != 1) return 2;",
        "  printf(\"%d\\n\", challenge + 1);",
        "  fflush(stdout);",
        "  return 0;",
        "}",
      ].join("\n"));
    const interactor = await compileC("interactor", [
        "#include <stdio.h>",
        "int main(int argc, char **argv) {",
        "  if (argc < 2) return 2;",
        "  FILE *input = fopen(argv[1], \"r\");",
        "  int target = 0, answer = 0;",
        "  if (!input || fscanf(input, \"%d\", &target) != 1) return 2;",
        "  printf(\"%d\\n\", target - 1);",
        "  fflush(stdout);",
        "  if (scanf(\"%d\", &answer) != 1) return 2;",
        "  return answer == target ? 0 : 1;",
        "}",
      ].join("\n"));

    const result = await engine.judge(contestant, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "interactive",
        id: "compiled-dialogue",
        input: { kind: "inline", value: "42\n" },
        files: { "/judge/secret.txt": { kind: "inline", value: "never-mounted-for-contestant\n" } },
        interactor: {
          program: asTrustedJudge(interactor),
          inputPath: "/judge/input.txt",
          args: ["/judge/input.txt"],
        },
      }],
    });

    expect(result.verdict).toBe("accepted");
    expect(result.cases[0]?.interaction).toMatchObject({
      contestantToInteractor: "42\n",
      interactorToContestant: "41\n",
      contestant: { code: 0, termination: "exited" },
      interactor: { code: 0, termination: "exited" },
    });
  });

  it("meters an interactive contestant exactly like a standalone run", { timeout: 300_000 }, async () => {
    const contestant = await compileC("spinner", [
        "int main(void) {",
        "  volatile unsigned long long sink = 0;",
        "  for (unsigned long long i = 0; i < 3000000ULL; ++i) sink = sink + i;",
        "  return (int)(sink & 1);",
        "}",
      ].join("\n"));
    const execute = async (instructionBudget: number) => {
      const resources = { instructionBudget, wallTimeLimitMs: 60_000 };
      const standalone = await engine.run(contestant, { resources });
      const interactive = await engine.interact(contestant, contestant, {
        contestant: { resources },
        interactor: { resources },
      });
      expect(interactive.interactor).toMatchObject({
        code: interactive.contestant.code,
        termination: interactive.contestant.termination,
        metrics: { cost: interactive.contestant.metrics.cost },
      });
      return { standalone, interactive: interactive.contestant };
    };

    const unlimited = await execute(1_000_000_000);
    expect(unlimited.standalone).toMatchObject({ code: 0, termination: "exited" });
    expect(unlimited.interactive).toMatchObject({ code: 0, termination: "exited" });
    expect(unlimited.interactive.metrics.cost).toBe(unlimited.standalone.metrics.cost);

    const budget = unlimited.standalone.metrics.cost! - 1;
    const limited = await execute(budget);
    expect(limited.standalone).toMatchObject({ code: 137, termination: "instruction-limit" });
    expect(limited.interactive).toMatchObject({ code: 137, termination: "instruction-limit" });
    expect(limited.interactive.metrics.cost).toBe(budget);
    expect(limited.interactive.metrics.cost).toBe(limited.standalone.metrics.cost);
  });

  it("stops a CPU-bound interactive contestant at the default budget well before the wall deadline", { timeout: 300_000 }, async () => {
    const contestant = await compileC("forever", "int main(void) { for (;;); }");
    const interactor = await compileC("silent-interactor", "int main(void) { return 0; }");
    const resources = { wallTimeLimitMs: 6_000 };

    const result = await engine.interact(contestant, interactor, { contestant: { resources }, interactor: { resources } });

    expect(result.contestant).toMatchObject({ code: 137, termination: "instruction-limit" });
    expect(result.interactor).toMatchObject({ code: 0, termination: "exited" });
  });

  it("runs a CPython interactor against a compiled contestant", { timeout: 300_000 }, async () => {
    const contestant = await compileC("bundle-contestant", [
        "#include <stdio.h>",
        "int main(void) {",
        "  int challenge = 0;",
        "  if (scanf(\"%d\", &challenge) != 1) return 2;",
        "  printf(\"%d\\n\", challenge + 1);",
        "  fflush(stdout);",
        "  return 0;",
        "}",
      ].join("\n"));
    const built = await engine.compile({
      projectId: "judge-integration:python-interactor",
      name: "python-interactor",
      language: "python",
      entry: "main.py",
      files: {
        "main.py": [
          "import sys",
          "target = int(open(sys.argv[1]).read())",
          "print(target - 1, flush=True)",
          "sys.exit(0 if int(input()) == target else 1)",
        ].join("\n") + "\n",
      },
    }, { cache: false });
    expect(built.success).toBe(true);
    expect(built.artifact?.kind).toBe("runtime-bundle");

    const result = await engine.interact(contestant, built.artifact!, {
      interactor: { args: ["/judge/input.txt"], files: { "/judge/input.txt": "42\n" } },
    });

    expect(result).toMatchObject({
      contestantToInteractor: "42\n",
      interactorToContestant: "41\n",
      contestant: { code: 0, termination: "exited" },
      interactor: { code: 0, termination: "exited" },
    });
  });

  async function compileC(name: string, source: string): Promise<BuildArtifact> {
    const entry = `src/${name}.c`;
    const input: CompileInput = {
      projectId: `judge-integration:${name}`,
      name,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry,
      files: { [entry]: `${source}\n` },
    };
    const result = await engine.compile(input, { cache: false });
    expect(result.diagnostics).toEqual([]);
    if (!result.success || !result.artifact) {
      throw new Error(`Failed to compile ${name}: ${result.stderr}`);
    }
    return result.artifact;
  }

  function asTrustedJudge(artifact: BuildArtifact): TrustedJudgeProgram {
    if (artifact.kind !== "wasm") throw new Error("Trusted judge compilation must produce a Wasm artifact.");
    return { runtimeProfile: "c-wasip1-release", wasm: artifact.bytes };
  }
});
