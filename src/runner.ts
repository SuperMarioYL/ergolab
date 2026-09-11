/**
 * The panel runner: the core loop of an ErgoLab run.
 *
 * For every driver and every task it creates a fresh sandbox and walks
 * the three-stage lifecycle — setup script, agent run (through the
 * driver), verify script — recording one TaskResult per agent-task pair.
 * The exit code of the verify script is the only pass oracle: exit 0 is
 * a pass, anything else is a fail. No LLM judge, no fuzzy matching, by
 * design.
 *
 * The AgentDriver interface below is the extension point of the whole
 * tool. Real agent CLIs (claude-code, codex, gemini-cli) implement it;
 * src/drivers/mock.ts implements the keyless deterministic one. Runs
 * are sequential — agent CLIs are rate-limited and flaky under
 * concurrency, and one sample per agent and task is the v0.1 protocol.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TIMEOUT_S } from "./schema";
import type { AgentReport, McpServer, PanelReport, Task, TaskResult } from "./schema";
import type { LoadedSuite } from "./suite";

/** Everything a driver needs to run one task against one sandbox. */
export interface AgentRunInput {
  /** The task being run. */
  task: Task;
  /** Fresh sandbox directory: the agent's working directory. */
  sandbox: string;
  /**
   * Absolute suite directory. Drivers resolve suite-relative paths
   * (such as MCP server commands) against it.
   */
  suiteDir: string;
  /**
   * MCP servers declared by the suite. Drivers that support
   * registration wire these into their CLI before running the agent.
   */
  mcpServers: Record<string, McpServer>;
  /** Task timeout in seconds. Drivers must enforce it on their subprocesses. */
  timeoutS: number;
}

/** How one agent invocation ended, from the driver's point of view. */
export type AgentRunOutcome =
  | { kind: "completed"; tokens?: number }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

/**
 * A coding-agent driver. `runAgent` should return an error outcome for
 * task-level failures rather than throw; the runner also converts a
 * thrown driver bug into an error result so one broken driver cannot
 * abort the whole panel report.
 */
export interface AgentDriver {
  /** Driver id used in reports: "claude-code" | "codex" | "gemini-cli" | "mock". */
  readonly name: string;
  runAgent(input: AgentRunInput): Promise<AgentRunOutcome>;
}

export interface RunSuiteOptions {
  /** The suite to run. */
  suite: LoadedSuite;
  /** Drivers forming the panel, in report order. */
  drivers: readonly AgentDriver[];
  /**
   * Root directory for sandbox workdirs (sandbox/<driver>/<task>-<rand>/).
   * Defaults to ./sandbox under the current working directory.
   */
  sandboxRoot?: string;
}

interface ShellResult {
  code: number | null;
  timedOut: boolean;
}

/**
 * Run every task against every driver, sequentially, and collect the
 * panel report. Each agent-task pair gets a brand-new sandbox, so
 * nothing leaks between cells of the matrix.
 */
export async function runSuite(options: RunSuiteOptions): Promise<PanelReport> {
  const { suite, drivers, sandboxRoot = "sandbox" } = options;
  const agents: AgentReport[] = [];

  for (const driver of drivers) {
    const results: TaskResult[] = [];
    for (const task of suite.suite.tasks) {
      results.push(await runTask(driver, task, suite, sandboxRoot));
    }
    agents.push({ driver: driver.name, results });
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
