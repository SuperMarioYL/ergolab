/**
 * The Gemini CLI driver: one headless `gemini -p <prompt>
 * --output-format json` run per task, executed in the task's sandbox.
 *
 * The headless invocation is coded from the CLI's documented
 * non-interactive mode — `-p/--prompt` for the ask, `--output-format
 * json` for machine-readable output, `-y/--yolo` so tool use cannot
 * stall on approval prompts (a panel whose agent is denied every action
 * measures the harness, not the agent), and `--mcp-config <file>` with
 * the same `{ "mcpServers": ... }` shape `~/.gemini/settings.json`
 * uses, so the user's own settings are never touched.
 *
 * Unlike the claude-code and codex drivers, this invocation is
 * UNVERIFIED locally: no gemini binary exists on the build machine, so
 * the flags and the output shape could not be sampled. The driver is
 * therefore defensive by design — the token parser accepts the Gemini
 * API's usage naming wherever the CLI nests it and reports no tokens
 * rather than guessing, and an agent with no runnable binary anywhere
 * resolves as skipped (`not-found`), keeping its row in the panel
 * report instead of being silently dropped.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "../runner";

/** Driver id used in panel reports. */
export const GEMINI_CLI_DRIVER_NAME = "gemini-cli";

/** The binary name the PATH probe looks for. */
const CLI_COMMAND = "gemini";

/**
 * Install locations probed when PATH has no `gemini`: the npm -g bin
 * dirs the @google/gemini-cli package installs into.
 */
const CLI_FALLBACK_PATHS: readonly string[] = [
  path.join(homedir(), ".local", "bin", CLI_COMMAND),
  "/usr/local/bin/gemini",
  "/opt/homebrew/bin/gemini",
];

/** Per-run MCP config, written into the sandbox, passed via --mcp-config. */
const MCP_CONFIG_BASENAME = ".ergolab-mcp.json";

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

/**
 * Write the suite's MCP servers as an `--mcp-config` file in the
 * sandbox, in the shape `~/.gemini/settings.json` uses.
 */
async function writeMcpConfig(input: AgentRunInput): Promise<string> {
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const [name, server] of Object.entries(input.mcpServers)) {
    servers[name] = {
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
  const argv = [binaryPath, "-y", "--output-format", "json"];
  if (Object.keys(input.mcpServers).length > 0) {
    argv.push("--mcp-config", await writeMcpConfig(input));
  }
  argv.push("-p", input.task.prompt);
  return argv;
}

// -- output parsing ---------------------------------------------------------

/**
 * Token usage from the CLI's JSON output, best effort: the output shape
 * cannot be sampled without a gemini binary, so the parser accepts the
 * Gemini API's `total_token_count` / `totalTokenCount` naming wherever
 * the CLI nests it, and reports no tokens rather than guessing.
 */
function parseUsage(stdout: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  return findTotalTokens(parsed, 0);
}

/** Depth-bounded search for a total-token count in the CLI's JSON output. */
function findTotalTokens(node: unknown, depth: number): number | undefined {
  if (depth > 4 || typeof node !== "object" || node === null) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "total_token_count" || key === "totalTokenCount" || key === "total_tokens") && typeof value === "number") {
      return value;
    }
  }
  for (const value of Object.values(node)) {
    const found = findTotalTokens(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// -- the driver -------------------------------------------------------------

/** The Gemini CLI driver: the AgentDriver contract plus the CLI seam. */
export interface GeminiCliDriver extends AgentDriver {
  /** Resolve the CLI binary: PATH first, then known install locations. */
  detect(): Promise<CliResolution>;
  /** Full headless argv for one task; undefined when the CLI cannot run. */
  buildInvocation(input: AgentRunInput): Promise<string[] | undefined>;
  /** Token usage from the CLI's JSON output; undefined when not reported. */
  parseUsage(rawOutput: string): number | undefined;
}

/**
 * Create a Gemini CLI driver. Never auto-invoked: importing this module
 * spawns nothing; the CLI runs only when the runner calls `runAgent`.
 */
export function createGeminiCliDriver(options: CliDriverOptions = {}): GeminiCliDriver {
  const preResolved = options.binaryPath !== undefined && options.binaryPath !== "" ? options.binaryPath : undefined;
  let resolution: CliResolution | undefined =
    preResolved !== undefined ? { status: "runnable", path: preResolved } : undefined;

  /** The PATH/fallback probe runs at most once per driver instance. */
  const resolve = (): CliResolution =>
    (resolution ??= resolveCli(CLI_COMMAND, CLI_FALLBACK_PATHS, process.env.PATH ?? ""));

  return {
    name: GEMINI_CLI_DRIVER_NAME,

    detect: async () => resolve(),

    buildInvocation: async (input) => {
      const cli = resolve();
      return cli.status === "runnable" ? buildArgv(cli.path, input) : undefined;
    },

    parseUsage,

    async runAgent(input: AgentRunInput): Promise<AgentRunOutcome> {
      const cli = resolve();
      if (cli.status === "skipped") {
        return { kind: "error", message: `gemini CLI not runnable (${cli.reason})` };
      }

      const result = await runCli(await buildArgv(cli.path, input), input.sandbox, input.timeoutS);
      if (result.timedOut) return { kind: "timeout" };
      if (result.code !== 0) return { kind: "error", message: failureMessage("gemini", result) };
      return { kind: "completed", tokens: parseUsage(result.stdout) };
    },
  };
}
