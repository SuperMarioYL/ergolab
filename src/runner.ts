/**
 * The panel runner: the core loop of an ErgoLab run.
 *
 * For every panel member and every task it creates a fresh sandbox and
 * walks the three-stage lifecycle — setup script, agent run (through the
 * driver), verify script — recording one TaskResult per agent-task pair.
 * The exit code of the verify script is the only pass oracle: exit 0 is
 * a pass, anything else is a fail. No LLM judge, no fuzzy matching, by
 * design.
 *
 * A panel member is either a driver that runs, or an agent that cannot
 * (no runnable binary anywhere): skipped agents keep their row in the
 * report — with the detect reason — so panel coverage stays visible.
 * The AgentDriver contract itself lives in src/drivers/types.ts; real
 * agent CLIs (claude-code, codex, gemini-cli) implement it,
 * src/drivers/mock.ts implements the keyless deterministic one. Runs
 * are sequential — agent CLIs are rate-limited and flaky under
 * concurrency, and one sample per agent and task is the v0.1 protocol.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TIMEOUT_S } from "./schema";
import type { AgentReport, PanelReport, Task, TaskResult } from "./schema";
import type { LoadedSuite } from "./suite";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "./drivers/types";

// The driver contract is re-exported here for package consumers: the
// runner is the orchestrator that calls it, so it stays the public face.
export type { AgentDriver, AgentRunInput, AgentRunOutcome } from "./drivers/types";

/**
 * An agent that will not run at all. Its row stays in the report — with
 * the reason binary discovery reported ("not-found" or
 * "off-path-at <path>", owned by src/drivers/detect.ts) — instead of
 * being silently dropped.
 */
export interface SkippedAgent {
  readonly name: string;
  readonly skipped: string;
}

/** A panel member: a driver that runs, or an agent that cannot. */
export type PanelMember = AgentDriver | SkippedAgent;

/** True for panel members that carry a skip instead of a driver. */
function isSkipped(member: PanelMember): member is SkippedAgent {
  return "skipped" in member;
}

export interface RunSuiteOptions {
  /** The suite to run. */
  suite: LoadedSuite;
  /**
   * The panel, in report order: drivers that run plus agents that
   * cannot (kept as skipped rows).
   */
  drivers: readonly PanelMember[];
  /**
   * Root directory for sandbox workdirs (sandbox/<driver>/<task>-<rand>/).
   * Defaults to ./sandbox under the current working directory.
   */
  sandboxRoot?: string;
  /**
   * Progress callback: invoked with each finished result, in run order.
   * The CLI uses it to print the panel filling in; silent runs omit it.
   */
  onTaskResult?: (agent: string, result: TaskResult) => void;
}

interface ShellResult {
  code: number | null;
  timedOut: boolean;
}

/**
 * Run every task against every panel member, sequentially, and collect
 * the panel report. Each agent-task pair gets a brand-new sandbox, so
 * nothing leaks between cells of the matrix; a skipped agent keeps its
 * row (with its reason and no results) so coverage stays visible.
 */
export async function runSuite(options: RunSuiteOptions): Promise<PanelReport> {
  const { suite, drivers, sandboxRoot = "sandbox", onTaskResult } = options;
  const agents: AgentReport[] = [];

  for (const member of drivers) {
    if (isSkipped(member)) {
      agents.push({ driver: member.name, skipped: member.skipped, results: [] });
      continue;
    }
    const results: TaskResult[] = [];
    for (const task of suite.suite.tasks) {
      const result = await runTask(member, task, suite, sandboxRoot);
      results.push(result);
      onTaskResult?.(member.name, result);
    }
    agents.push({ driver: member.name, results });
  }

  return { suite: suite.name, generated_at: new Date().toISOString(), agents };
}

async function runTask(
  driver: AgentDriver,
  task: Task,
  loaded: LoadedSuite,
  sandboxRoot: string,
): Promise<TaskResult> {
  const timeoutS = task.timeout_s ?? DEFAULT_TIMEOUT_S;
  const startedAt = Date.now();
  const sandbox = await makeSandbox(sandboxRoot, driver.name, task.name);
  const finish = (result: Omit<TaskResult, "task" | "wall_ms">): TaskResult => ({
    task: task.name,
    wall_ms: Date.now() - startedAt,
    ...result,
  });

  if (task.setup !== undefined) {
    const setup = await runShell(task.setup, sandbox, timeoutS);
    if (setup.timedOut) return finish({ status: "timeout", stage: "setup" });
    if (setup.code !== 0) return finish({ status: "error", stage: "setup" });
  }

  const outcome = await invokeDriver(driver, {
    task,
    sandbox,
    suiteDir: loaded.dir,
    mcpServers: loaded.suite.mcp_servers ?? {},
    timeoutS,
  });
  if (outcome.kind === "error") return finish({ status: "error", stage: "agent" });
  if (outcome.kind === "timeout") return finish({ status: "timeout", stage: "agent" });

  const verify = await runShell(task.verify, sandbox, timeoutS);
  if (verify.timedOut) return finish({ status: "timeout", stage: "verify" });
  if (verify.code !== 0) return finish({ status: "fail", stage: "verify" });
  return finish({ status: "pass", stage: "verify", tokens: outcome.tokens });
}

/** A thrown driver error is a driver bug, not a run abort: record and continue. */
async function invokeDriver(driver: AgentDriver, input: AgentRunInput): Promise<AgentRunOutcome> {
  try {
    return await driver.runAgent(input);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** sandbox/<driver>/<task>-<random>/ — fresh for every agent-task pair. */
async function makeSandbox(root: string, driverName: string, taskName: string): Promise<string> {
  const parent = path.join(root, sanitizeSegment(driverName), sanitizeSegment(taskName));
  await mkdir(parent, { recursive: true });
  return mkdtemp(`${parent}${path.sep}`);
}

/** Driver and task names are free-form strings; keep them from escaping the sandbox root. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/**
 * Run a shell command in `cwd`, killed with SIGKILL after `timeoutS`
 * seconds. The shell is spawned detached so the whole process group
 * dies with it — a timed-out script must not leave children behind.
 */
function runShell(command: string, cwd: string, timeoutS: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, detached: true, stdio: "ignore" });
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutS * 1000);

    const settle = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", () => settle({ code: null, timedOut: false }));
    child.on("close", (code) => settle({ code, timedOut }));
  });
}
