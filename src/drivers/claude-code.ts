/**
 * The Claude Code driver: one headless `claude -p <prompt>
 * --output-format json` run per task, executed in the task's sandbox.
 *
 * The invocation follows the CLI's headless mode: `-p/--print` prints
 * the response and exits; `--output-format json` emits a single result
 * object whose `usage` carries the token counts (input, output, and the
 * cache fields); `--mcp-config <file>` registers the suite's stdio MCP
 * servers for the run, using the same `{ "mcpServers": ... }` shape
 * `~/.claude.json` uses, so the user's own config is never touched.
 *
 * `--dangerously-skip-permissions` is deliberate: a non-interactive run
 * cannot answer permission prompts, and a panel whose agent is denied
 * every write measures the harness, not the agent. Every run gets a
 * fresh, disposable sandbox workdir.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDriver, AgentRunInput, AgentRunOutcome, CliDriverOptions, CliResolution } from "./types";
import { resolveDriverCli } from "./detect";

/** Driver id used in panel reports. */
export const CLAUDE_CODE_DRIVER_NAME = "claude-code";

/** Per-run MCP config, written into the sandbox, passed via --mcp-config. */
const MCP_CONFIG_BASENAME = ".ergolab-mcp.json";

// -- CLI resolution ---------------------------------------------------------
//
// Probe order and skip-reason format are owned by src/drivers/detect.ts:
// PATH first, then this driver's known install locations. A binary found
// at a fallback location runs from there; an agent with no runnable
// binary anywhere keeps its row in the panel report as skipped.

// -- CLI subprocess ---------------------------------------------------------

/** What a CLI run produced: exit code, timeout flag, captured streams. */
interface CliRunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run one CLI invocation in `cwd`. The child is spawned detached so the
 * whole process group dies on timeout: after `timeoutS` seconds the
 * group is SIGKILLed (MCP servers the CLI spawned go down with it) and
 * the result is flagged `timedOut`. Streams are captured as buffers and
 * decoded once, so multi-byte output split across chunks survives; the
 * environment is inherited so the CLI keeps the user's normal auth.
 */
function runCli(argv: string[], cwd: string, timeoutS: number): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // the process group is already gone
      }
      child.kill("SIGKILL");
    }, timeoutS * 1000);

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      stderrChunks.push(Buffer.from(`\n${error.message}`));
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

/** A bounded failure message: the exit code plus a short stream tail. */
function failureMessage(cli: string, result: CliRunResult): string {
  const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join("\n");
  const suffix = result.code === null ? "without an exit code" : `with code ${result.code}`;
  return tail !== "" ? `${cli} exited ${suffix}:\n${tail}` : `${cli} exited ${suffix}`;
}

// -- suite wiring -----------------------------------------------------------

/**
 * Suite MCP entries reference suite files by paths relative to the
 * suite directory (e.g. `server/index.ts`); anything that names an
 * existing file there is made absolute so the agent CLI can find it
 * from the sandbox. Flags and bare words pass through untouched.
 */
function resolveSuitePath(value: string, suiteDir: string): string {
  if (value.startsWith("-") || path.isAbsolute(value)) return value;
  const candidate = path.join(suiteDir, value);
  return existsSync(candidate) ? candidate : value;
}

/**
 * Write the suite's MCP servers as a `--mcp-config` file in the sandbox,
 * in the shape `~/.claude.json` uses for stdio servers.
 */
async function writeMcpConfig(input: AgentRunInput): Promise<string> {
  const servers: Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> = {};
  for (const [name, server] of Object.entries(input.mcpServers)) {
    servers[name] = {
      type: "stdio",
      command: resolveSuitePath(server.command, input.suiteDir),
      args: (server.args ?? []).map((arg) => resolveSuitePath(arg, input.suiteDir)),
      env: {},
    };
  }
  const file = path.join(input.sandbox, MCP_CONFIG_BASENAME);
  await writeFile(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return file;
}

/** Full headless argv; suite MCP servers are wired in via --mcp-config. */
async function buildArgv(binaryPath: string, input: AgentRunInput): Promise<string[]> {
  const argv = [binaryPath, "-p", input.task.prompt, "--output-format", "json", "--dangerously-skip-permissions"];
  if (Object.keys(input.mcpServers).length > 0) {
    argv.push("--mcp-config", await writeMcpConfig(input));
  }
  return argv;
}

// -- output parsing ---------------------------------------------------------

/** The fields ErgoLab reads from a `claude -p --output-format json` result. */
interface HeadlessResult {
  isError: boolean;
  message: string;
  usage?: Record<string, unknown>;
}

/** Token fields of the result's `usage` object, cache fields included. */
const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;

function parseResult(stdout: string): HeadlessResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const result = parsed as Record<string, unknown>;
  return {
    isError: result.is_error === true || result.isError === true,
    message: typeof result.result === "string" ? result.result : "",
    usage:
      typeof result.usage === "object" && result.usage !== null
        ? (result.usage as Record<string, unknown>)
        : undefined,
  };
}

/** The usage object's token total, or undefined when it reports none. */
function sumTokens(usage: Record<string, unknown> | undefined): number | undefined {
  if (usage === undefined) return undefined;
  let total = 0;
  let seen = false;
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value === "number") {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

// -- the driver -------------------------------------------------------------

/** The Claude Code driver: the AgentDriver contract plus the CLI seam. */
export interface ClaudeCodeDriver extends AgentDriver {
  /** Resolve the CLI binary: PATH first, then known install locations. */
  detect(): Promise<CliResolution>;
  /** Full headless argv for one task; undefined when the CLI cannot run. */
  buildInvocation(input: AgentRunInput): Promise<string[] | undefined>;
  /** Token usage from the CLI's JSON output; undefined when not reported. */
  parseUsage(rawOutput: string): number | undefined;
}

/**
 * Create a Claude Code driver. Never auto-invoked: importing this module
 * spawns nothing; the CLI runs only when the runner calls `runAgent`.
 */
export function createClaudeCodeDriver(options: CliDriverOptions = {}): ClaudeCodeDriver {
  const preResolved = options.binaryPath !== undefined && options.binaryPath !== "" ? options.binaryPath : undefined;
  let resolution: CliResolution | undefined =
    preResolved !== undefined ? { status: "runnable", path: preResolved } : undefined;

  /** The PATH/fallback probe (src/drivers/detect.ts) runs at most once per driver instance. */
  const resolve = (): CliResolution => (resolution ??= resolveDriverCli(CLAUDE_CODE_DRIVER_NAME));

  return {
    name: CLAUDE_CODE_DRIVER_NAME,

    detect: async () => resolve(),

    buildInvocation: async (input) => {
      const cli = resolve();
      return cli.status === "runnable" ? buildArgv(cli.path, input) : undefined;
    },

    parseUsage: (rawOutput) => sumTokens(parseResult(rawOutput)?.usage),

    async runAgent(input: AgentRunInput): Promise<AgentRunOutcome> {
      const cli = resolve();
      if (cli.status === "skipped") {
        return { kind: "error", message: `claude CLI not runnable (${cli.reason})` };
      }

      const result = await runCli(await buildArgv(cli.path, input), input.sandbox, input.timeoutS);
      if (result.timedOut) return { kind: "timeout" };
      if (result.code !== 0) return { kind: "error", message: failureMessage("claude", result) };

      const parsed = parseResult(result.stdout);
      if (parsed === undefined) {
        return { kind: "error", message: "claude produced no parsable JSON result" };
      }
      if (parsed.isError) {
        return { kind: "error", message: parsed.message || "claude reported an error result" };
      }
      return { kind: "completed", tokens: sumTokens(parsed.usage) };
    },
  };
}
