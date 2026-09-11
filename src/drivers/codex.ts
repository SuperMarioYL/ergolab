/**
 * The Codex driver: one headless `codex exec --json <prompt>` run per
 * task, executed in the task's sandbox.
 *
 * The invocation follows the CLI's non-interactive mode: `exec` runs the
 * agent without a terminal; `--json` prints events as JSONL on stdout
 * (token usage arrives on `turn.completed` events); `--skip-git-repo-
 * check` allows the fresh, non-git sandbox workdir; `-s workspace-write`
 * keeps the agent's writes inside that workdir without approval stalls —
 * a panel whose agent cannot write its answer measures the harness, not
 * the agent; `-C`/`-o` pin the working root and the final-message file.
 *
 * Suite MCP servers are registered per run with `-c
 * mcp_servers.<name>={...}` config overrides — the inline form of the
 * `[mcp_servers.<name>]` table `~/.codex/config.toml` uses — so the
 * user's config file is never edited.
 *
 * Binary discovery matters most here: on macOS, Codex ships inside
 * ChatGPT.app at /Applications/ChatGPT.app/Contents/Resources/codex, an
 * install that never touches PATH. The probe below finds it; an agent
 * with no runnable binary anywhere is reported as skipped with a reason,
 * never silently dropped.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServer } from "../schema";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "../runner";

/** Driver id used in panel reports. */
export const CODEX_DRIVER_NAME = "codex";

/** The binary name the PATH probe looks for. */
const CLI_COMMAND = "codex";

/**
 * Install locations probed when PATH has no `codex`: the usual npm -g
 * bin dirs, plus (on macOS) the codex binary bundled as a ChatGPT.app
 * resource.
 */
const CLI_FALLBACK_PATHS: readonly string[] = [
  path.join(homedir(), ".local", "bin", CLI_COMMAND),
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex",
  ...(process.platform === "darwin" ? ["/Applications/ChatGPT.app/Contents/Resources/codex"] : []),
];

/** Where the CLI writes the agent's final message (a run debugging aid). */
const LAST_MESSAGE_BASENAME = ".ergolab-last-message.txt";

// -- CLI resolution ---------------------------------------------------------
//
// The seam src/drivers/detect.ts absorbs. Probe order and skip-reason
// format are identical across the CLI drivers: PATH first (the same
// probe `which <cli>` performs, without a subprocess), then the driver's
// known fallback locations. A fallback binary that runs is used from
// where it was found; one that exists but cannot run reports
// `off-path-at <path>`; nothing anywhere reports `not-found`. Either way
// the agent keeps its row in the panel report — coverage stays visible.

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

/**
 * Resolve a CLI binary: PATH first, then `fallbacks`. The reason strings
 * are report values — `not-found`, `off-path-at <path>` — kept verbatim
 * in the agent's skipped row.
 */
export function resolveCli(command: string, fallbacks: readonly string[], pathEnv: string): CliResolution {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return { status: "runnable", path: candidate };
  }
  for (const candidate of fallbacks) {
    if (isExecutableFile(candidate)) return { status: "runnable", path: candidate };
    if (existsSync(candidate)) return { status: "skipped", reason: `off-path-at ${candidate}` };
  }
  return { status: "skipped", reason: "not-found" };
}

/** A regular file with an execute bit — what `which` would accept. */
function isExecutableFile(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

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

/** A TOML basic string, escaped so values with quotes or backslashes survive the round trip. */
function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/** Bare TOML keys stay unquoted; anything else is quoted. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/**
 * One `-c` config override registering a stdio MCP server, e.g.
 * `mcp_servers.registry={command="node",args=["serve"]}`.
 */
function tomlMcpOverride(name: string, server: McpServer, suiteDir: string): string {
  const args = (server.args ?? []).map((arg) => tomlString(resolveSuitePath(arg, suiteDir)));
  return `mcp_servers.${tomlKey(name)}={command=${tomlString(resolveSuitePath(server.command, suiteDir))},args=[${args.join(",")}]}`;
}

/** Full headless argv; each suite MCP server becomes one -c override. */
function buildArgv(binaryPath: string, input: AgentRunInput): string[] {
  const argv = [
    binaryPath,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-C",
    input.sandbox,
    "-o",
    path.join(input.sandbox, LAST_MESSAGE_BASENAME),
  ];
  for (const [name, server] of Object.entries(input.mcpServers)) {
    argv.push("-c", tomlMcpOverride(name, server, input.suiteDir));
  }
  argv.push(input.task.prompt);
  return argv;
}

// -- output parsing ---------------------------------------------------------

/** Token fields of a codex usage object (exec events and session streams share the field names). */
const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

/** One JSONL line as an object; undefined for blank or unparsable lines. */
function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The value at `key` when `value` is an object holding it. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** A usage object's total: `total_tokens` when present, else the sum of its parts. */
function usageTotal(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  let sum = 0;
  let seen = false;
  for (const field of USAGE_FIELDS) {
    const value = record[field];
    if (typeof value !== "number") continue;
    if (field === "total_tokens") return value;
    sum += value;
    seen = true;
  }
  return seen ? sum : undefined;
}

/**
 * Token usage from the JSONL event stream: the largest usage any event
 * reported. `codex exec --json` emits `turn.completed` events carrying a
 * `usage` object; session-shaped streams report the same numbers under
 * `total_token_usage`. Both are accepted — usage is monotonic within a
 * run, so the maximum is the run's total.
 */
function parseUsage(stdout: string): number | undefined {
  let total: number | undefined;
  for (const line of stdout.split("\n")) {
    const event = parseJsonLine(line);
    if (event === undefined) continue;
    const candidates = [
      fieldOf(event, "usage"),
      fieldOf(event, "total_token_usage"),
      fieldOf(fieldOf(fieldOf(event, "payload"), "info"), "total_token_usage"),
    ];
    for (const usage of candidates) {
      const candidate = usageTotal(usage);
      if (candidate !== undefined && (total === undefined || candidate > total)) total = candidate;
    }
  }
  return total;
}

/** The failure message in a JSONL stream, when the run failed: `error` and `turn.failed` events both carry one. */
function streamFailure(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const event = parseJsonLine(line);
    if (event === undefined) continue;
    if (event.type === "error" && typeof event.message === "string") return event.message;
    const turnError = fieldOf(fieldOf(event, "error"), "message");
    if (event.type === "turn.failed" && typeof turnError === "string") return turnError;
  }
  return undefined;
}

// -- the driver -------------------------------------------------------------

/** The Codex driver: the AgentDriver contract plus the CLI seam. */
export interface CodexDriver extends AgentDriver {
  /** Resolve the CLI binary: PATH first, then known install locations. */
  detect(): Promise<CliResolution>;
  /** Full headless argv for one task; undefined when the CLI cannot run. */
  buildInvocation(input: AgentRunInput): Promise<string[] | undefined>;
  /** Token usage from the CLI's JSONL output; undefined when not reported. */
  parseUsage(rawOutput: string): number | undefined;
}

/**
 * Create a Codex driver. Never auto-invoked: importing this module
 * spawns nothing; the CLI runs only when the runner calls `runAgent`.
 */
export function createCodexDriver(options: CliDriverOptions = {}): CodexDriver {
  const preResolved = options.binaryPath !== undefined && options.binaryPath !== "" ? options.binaryPath : undefined;
  let resolution: CliResolution | undefined =
    preResolved !== undefined ? { status: "runnable", path: preResolved } : undefined;

  /** The PATH/fallback probe runs at most once per driver instance. */
  const resolve = (): CliResolution =>
    (resolution ??= resolveCli(CLI_COMMAND, CLI_FALLBACK_PATHS, process.env.PATH ?? ""));

  return {
    name: CODEX_DRIVER_NAME,

    detect: async () => resolve(),

    buildInvocation: async (input) => {
      const cli = resolve();
      return cli.status === "runnable" ? buildArgv(cli.path, input) : undefined;
    },

    parseUsage,

    async runAgent(input: AgentRunInput): Promise<AgentRunOutcome> {
      const cli = resolve();
      if (cli.status === "skipped") {
        return { kind: "error", message: `codex CLI not runnable (${cli.reason})` };
      }

      const result = await runCli(buildArgv(cli.path, input), input.sandbox, input.timeoutS);
      if (result.timedOut) return { kind: "timeout" };
      if (result.code !== 0) return { kind: "error", message: failureMessage("codex", result) };

      const failure = streamFailure(result.stdout);
      if (failure !== undefined) return { kind: "error", message: failure };
      return { kind: "completed", tokens: parseUsage(result.stdout) };
    },
  };
}
