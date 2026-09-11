import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mockDriver } from "../src/drivers/mock";
import { runSuite } from "../src/runner";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "../src/runner";
import { PanelReportSchema, SUITE_FILENAME } from "../src/schema";
import { loadSuite } from "../src/suite";
import type { LoadedSuite } from "../src/suite";

const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ergolab-runner-test-"));
  scratchDirs.push(dir);
  return dir;
}

/** Load a suite written from inline YAML into a fresh temp directory. */
async function suiteFromYaml(yaml: string): Promise<LoadedSuite> {
  const dir = await scratchDir();
  await writeFile(path.join(dir, SUITE_FILENAME), yaml);
  return loadSuite(dir);
}

function fakeDriver(
  name: string,
  runAgent: (input: AgentRunInput) => Promise<AgentRunOutcome>,
): AgentDriver {
  return { name, runAgent };
}

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

const LOOKUP_PROMPT = "Find `hello-world` and write it to answer.txt.";
const LOOKUP_TASKS = `
tasks:
  - name: lookup
    setup: "echo 'hello-world 42' > data.txt"
    prompt: "${LOOKUP_PROMPT}"
    verify: "grep -q 42 answer.txt"
`;

describe("runSuite with the mock driver", () => {
  it("runs setup → agent → verify and records a pass", async () => {
    const suite = await suiteFromYaml(`tool: test-tool\n${LOOKUP_TASKS}`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(report.suite).toBe(suite.name);
    expect(report.generated_at).toEqual(expect.any(String));
    expect(report.agents).toHaveLength(1);
    const agent = report.agents[0];
    expect(agent.driver).toBe("mock");
    expect(agent.skipped).toBeUndefined();
    expect(agent.results).toHaveLength(1);

    const result = agent.results[0];
    expect(result.task).toBe("lookup");
    expect(result.status).toBe("pass");
    expect(result.stage).toBe("verify");
    expect(result.wall_ms).toBeGreaterThanOrEqual(0);
    expect(result.tokens).toBe(Math.ceil(LOOKUP_PROMPT.length / 4));

    // The report itself validates against the schema.
    expect(PanelReportSchema.parse(report)).toEqual(report);
  });

  it("fails at verify when the answer is not greppable in the sandbox", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: lookup
    prompt: "${LOOKUP_PROMPT}"
    verify: "grep -q 42 answer.txt"
`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    const result = report.agents[0].results[0];
    expect(result.status).toBe("fail");
    expect(result.stage).toBe("verify");
  });

  it("writes to the output file the prompt names", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: lookup
    setup: "echo 'hello-world 42' > data.txt"
    prompt: "Find \`hello-world\` and write them to deps.txt"
    verify: "grep -q 42 deps.txt"
`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(report.agents[0].results[0].status).toBe("pass");
  });

  it("gives every task a fresh sandbox within a run", async () => {
    // Both tasks share the prompt and verify; only the first seeds data.
    // If sandboxes leaked, the second would pass on the first's files.
    const suite = await suiteFromYaml(`
tool: test-tool
${LOOKUP_TASKS}
  - name: lookup-again
    prompt: "${LOOKUP_PROMPT}"
    verify: "grep -q 42 answer.txt"
`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    const statuses = report.agents[0].results.map((result) => result.status);
    expect(statuses).toEqual(["pass", "fail"]);
  });
});

describe("runSuite stage failures", () => {
  it("records an error at setup when the setup script fails", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: broken-setup
    setup: "exit 3"
    prompt: "do the thing"
    verify: "true"
`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(report.agents[0].results[0]).toMatchObject({ status: "error", stage: "setup", task: "broken-setup" });
  });

  it("records an error at agent when the driver reports one", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: boom
    prompt: "do the thing"
    verify: "true"
`);
    const driver = fakeDriver("boom", async () => ({ kind: "error", message: "CLI crashed" }));

    const report = await runSuite({ suite, drivers: [driver], sandboxRoot: await scratchDir() });

    expect(report.agents[0].results[0]).toMatchObject({ status: "error", stage: "agent" });
  });

  it("records a timeout at agent when the driver reports one", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: stuck
    prompt: "do the thing"
    verify: "true"
`);
    const driver = fakeDriver("stuck", async () => ({ kind: "timeout" }));

    const report = await runSuite({ suite, drivers: [driver], sandboxRoot: await scratchDir() });

    expect(report.agents[0].results[0]).toMatchObject({ status: "timeout", stage: "agent" });
  });

  it("records an error when the driver throws instead of returning an outcome", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: thrower
    prompt: "do the thing"
    verify: "true"
`);
    const driver = fakeDriver("thrower", async () => {
      throw new Error("driver bug");
    });

    const report = await runSuite({ suite, drivers: [driver], sandboxRoot: await scratchDir() });

    expect(report.agents[0].results[0]).toMatchObject({ status: "error", stage: "agent" });
  });

  it("kills a verify script that exceeds the task timeout", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
tasks:
  - name: slow-verify
    prompt: "do the thing"
    verify: "sleep 5"
    timeout_s: 1
`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    const result = report.agents[0].results[0];
    expect(result).toMatchObject({ status: "timeout", stage: "verify" });
    expect(result.wall_ms).toBeLessThan(5000);
  });
});

describe("runSuite panel shape", () => {
  it("keeps agents in driver order and results in suite order", async () => {
    const suite = await suiteFromYaml(`
tool: test-tool
${LOOKUP_TASKS}
  - name: other
    prompt: "do the other thing"
    verify: "true"
`);
    const drivers = [
      mockDriver,
      fakeDriver("silent", async () => ({ kind: "completed" })),
    ];

    const report = await runSuite({ suite, drivers, sandboxRoot: await scratchDir() });

    expect(report.agents.map((agent) => agent.driver)).toEqual(["mock", "silent"]);
    expect(report.agents[0].results.map((result) => result.task)).toEqual(["lookup", "other"]);
    expect(report.agents[1].results.map((result) => result.task)).toEqual(["lookup", "other"]);
  });

  it("produces a report that validates against the schema", async () => {
    const suite = await suiteFromYaml(`tool: test-tool\n${LOOKUP_TASKS}`);

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(() => PanelReportSchema.parse(report)).not.toThrow();
  });
});
