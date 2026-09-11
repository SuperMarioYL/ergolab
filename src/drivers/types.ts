/**
 * The driver contract: the only extension point ErgoLab has.
 *
 * A driver adapts one coding agent — claude-code, codex, gemini-cli, or
 * the keyless mock — to the single `runAgent` operation the runner
 * calls. CLI drivers add two shared concerns on top: how their binary
 * resolved (the CliResolution values src/drivers/detect.ts produces) and
 * the option to inject a pre-resolved binary path (how tests and the
 * run command pin a binary without touching the machine).
 */
import type { McpServer, Task } from "../schema";

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

/** How a CLI driver's binary resolved for a run. */
export type CliResolution =
  | { status: "runnable"; path: string }
  | { status: "skipped"; reason: string };

/** Options every CLI driver accepts. */
export interface CliDriverOptions {
  /**
   * Pre-resolved CLI path (from src/drivers/detect.ts, or a test). When
   * set, PATH/fallback discovery is skipped entirely.
   */
  binaryPath?: string;
}
