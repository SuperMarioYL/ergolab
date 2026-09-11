/**
 * ErgoLab's core data model: the agent-panel affordance test.
 *
 * Two artifacts define the primitive:
 *
 * - the task suite (`ergolab.yaml`) — the test plan. Standard tasks run
 *   against a tool, each with an exit-code-deterministic verify script:
 *   exit 0 = pass, no LLM judge, no learned oracle.
 * - the panel report (`ergolab-report.json`) — the findings. One row per
 *   agent, one result per task, recording status, the stage the run ended
 *   in, wall time, and token cost.
 *
 * The zod schemas below are the single source of truth for both artifacts.
 * Suite loading (suite.ts), execution (runner.ts), and rendering (report.ts)
 * consume these shapes; only the shapes and their invariants live here.
 */
import { z } from "zod";

/** Suite definition file inside a suite directory. */
export const SUITE_FILENAME = "ergolab.yaml";

/** Panel report file written by a run. */
export const REPORT_FILENAME = "ergolab-report.json";

/** Timeout in seconds applied to tasks that do not set `timeout_s`. */
export const DEFAULT_TIMEOUT_S = 120;

/**
 * Drivers shipped with ErgoLab. `AgentReport.driver` stays an open string
 * so reports written by drivers added later still validate.
 */
export const KNOWN_DRIVERS = ["claude-code", "codex", "gemini-cli", "mock"] as const;
export type KnownDriver = (typeof KNOWN_DRIVERS)[number];

/** Terminal state of one agent-task pair. */
export const TASK_STATUSES = ["pass", "fail", "timeout", "error"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Lifecycle stage a run ended in: the setup script, the agent subprocess, or the verify script. */
export const RESULT_STAGES = ["setup", "agent", "verify"] as const;
export type ResultStage = (typeof RESULT_STAGES)[number];

/** A stdio MCP server registered for the agent for the duration of a run. */
export const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * One standard task: the ask, the sandbox preparation, and the pass check.
 * Strict mode so a mistyped key in `ergolab.yaml` fails validation instead
 * of being silently dropped.
 */
export const TaskSchema = z
  .object({
    /** Short identifier; report results reference tasks by this name. */
    name: z.string().min(1),
    /** The ask handed to the agent. */
    prompt: z.string().min(1),
    /** Shell run in the sandbox before the agent. Omitted when no preparation is needed. */
    setup: z.string().optional(),
    /** Shell whose exit code decides the outcome: 0 = pass, anything else = fail. */
    verify: z.string().min(1),
    /** Per-task timeout in seconds; the runner applies DEFAULT_TIMEOUT_S when unset. */
    timeout_s: z.number().int().positive().optional(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

/**
 * A task suite (`ergolab.yaml`): the test plan for one tool. Task names
 * must be unique because panel results are keyed by task name.
 */
export const SuiteSchema = z
  .object({
    /** The tool under test — its library, CLI, or docs. */
    tool: z.string().min(1),
    /** Optional stdio MCP servers registered for each agent before tasks run. */
    mcp_servers: z.record(z.string(), McpServerSchema).optional(),
    /** The standard tasks; at least one is required. */
    tasks: z.array(TaskSchema).min(1),
  })
  .strict()
  .refine((suite) => new Set(suite.tasks.map((task) => task.name)).size === suite.tasks.length, {
    message: "task names must be unique within a suite",
  });
export type Suite = z.infer<typeof SuiteSchema>;

/** One cell of the panel: how a single agent fared on a single task. */
export const TaskResultSchema = z.object({
  /** Task name, matching a task in the suite. */
  task: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  /** Where the run ended: the setup script, the agent subprocess, or the verify script. */
  stage: z.enum(RESULT_STAGES),
  /** Wall-clock duration of the full setup → agent → verify cycle, in milliseconds. */
  wall_ms: z.number().nonnegative(),
  /** Token usage when the driver can capture it from its CLI. */
  tokens: z.number().nonnegative().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** One row of the panel: a single agent across every suite task. */
export const AgentReportSchema = z.object({
  /** Driver that produced this row, e.g. "claude-code" or "mock". */
  driver: z.string().min(1),
  /**
   * Set when the agent could not run at all — "not-found", or
   * "off-path-at <path>" for a binary located off PATH that could not be
   * run from there. The row is kept (with empty results) so panel
   * coverage stays visible. The reason format is owned by detect.ts.
   */
  skipped: z.string().min(1).optional(),
  /** One result per suite task, in suite order; empty when the agent was skipped. */
  results: z.array(TaskResultSchema),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

/** The panel report (`ergolab-report.json`): the findings of one run. */
export const PanelReportSchema = z.object({
  /** Name of the suite that produced the report. */
  suite: z.string().min(1),
  /** ISO 8601 timestamp recorded when the run finished. */
  generated_at: z.string().datetime(),
  /** One row per agent in the panel, in run order. */
  agents: z.array(AgentReportSchema),
});
export type PanelReport = z.infer<typeof PanelReportSchema>;
