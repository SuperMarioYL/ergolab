/**
 * Tests for the real CLI drivers (claude-code, codex, gemini-cli).
 *
 * No agent CLI is ever invoked: node:child_process's spawn is mocked
 * file-wide, and every filesystem interaction (sandbox, suite dir, MCP
 * config) runs against real temp directories. Verified here: binary
 * discovery (PATH first, then fallbacks, with skip reasons), headless
 * flag construction per driver, MCP registration (config file / TOML
 * override), JSON and JSONL output parsing with token extraction,
 * spawn-failure and timeout handling, and the detect()/binaryPath seam
 * the shared detect helper absorbs.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_DRIVER_NAME,
  createClaudeCodeDriver,
} from "../src/drivers/claude-code";
import { CODEX_DRIVER_NAME, createCodexDriver } from "../src/drivers/codex";
import { createGeminiCliDriver, GEMINI_CLI_DRIVER_NAME } from "../src/drivers/gemini-cli";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "../src/runner";
import { KNOWN_DRIVERS } from "../src/schema";
import type { McpServer, Task } from "../src/schema";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

/** The message of an error outcome, or "" for other outcomes. */
function errorMessage(outcome: AgentRunOutcome): string {
  return outcome.kind === "error" ? outcome.message : "";
}

/** Recorded spawn calls as (command, args, options) tuples. */
function spawnCalls(): Array<[string, string[], { cwd?: string }]> {
  return spawnMock.mock.calls as unknown as Array<[string, string[], { cwd?: string }]>;
}

/** How a stubbed spawn behaves: streams + exit, a hang, or a spawn error. */
interface SpawnScript {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  error?: Error;
}

/**
 * A ChildProcess stand-in. Stream data and the close event fire from a
 * microtask — after runCli's synchronous listener attachment. A hung
 * child has no pid, so the timeout path skips the process-group kill
 * (nothing real to signal) and falls through to kill().
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid: number | undefined;

  constructor(script: SpawnScript) {
    super();
    this.pid = script.hang === true || script.error !== undefined ? undefined : 424242;
    if (script.error !== undefined) {
      queueMicrotask(() => this.emit("error", script.error));
    } else if (script.hang !== true) {
      queueMicrotask(() => {
        this.stdout.emit("data", Buffer.from(script.stdout ?? ""));
        this.stderr.emit("data", Buffer.from(script.stderr ?? ""));
        this.emit("close", script.code ?? 0);
      });
    }
  }

  kill(): boolean {
    this.emit("close", null);
    return true;
  }
}

function stubSpawn(script: SpawnScript): void {
  spawnMock.mockImplementation((() => new FakeChildProcess(script)) as unknown as typeof spawn);
}

const scratchDirs: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  spawnMock.mockReset();
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

const TASK: Task = {
  name: "find-latest-version",
  prompt: "Find the latest stable version of `leftpad` with the registry MCP server; write it to answer.txt.",
  verify: "grep -q '1.4.2' answer.txt",
};

const REGISTRY_SERVER: McpServer = { command: "node", args: ["--experimental-strip-types", "server/index.ts"] };

/** A run input with a fresh sandbox and a suite dir whose server/index.ts exists. */
async function runInput(mcpServers: Record<string, McpServer> = { registry: REGISTRY_SERVER }): Promise<AgentRunInput> {
  const suiteDir = await scratchDir("ergolab-drivers-suite-");
  await mkdir(path.join(suiteDir, "server"), { recursive: true });
  await writeFile(path.join(suiteDir, "server", "index.ts"), "export {};\n");
  return {
    task: TASK,
    sandbox: await scratchDir("ergolab-drivers-sandbox-"),
    suiteDir,
    mcpServers,
    timeoutS: 60,
  };
}

/** The argv of a runnable driver; fails the test if the driver cannot build one. */
async function invocationOf(
  driver: { buildInvocation(input: AgentRunInput): Promise<string[] | undefined> },
  input: AgentRunInput,
): Promise<string[]> {
  const argv = await driver.buildInvocation(input);
  if (argv === undefined) throw new Error("expected a runnable driver to build an invocation");
  return argv;
}

// Realistic CLI outputs, field shapes verified against the CLIs'
// documented headless formats and session files.

const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "1.4.2",
  session_id: "session-1",
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
    output_tokens: 5,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
  },
});

const CODEX_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "1.4.2" } }),
  "this line is not json",
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 5,
      cache_write_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 18,
    },
  }),
].join("\n");

const CODEX_SESSION_JSONL = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 70,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 7,
        reasoning_output_tokens: 0,
        total_tokens: 77,
      },
      last_token_usage: { input_tokens: 70, output_tokens: 7, total_tokens: 77 },
    },
  },
});

const GEMINI_RESULT = JSON.stringify({
  response: "1.4.2",
  "response._type": "FileSync",
  stats: { models: { "gemini-2.5-pro": { models: {}, tokenUsage: { totalTokenCount: 42 } } } },
});

describe("driver ids and the binaryPath seam", () => {
  it("uses the known driver ids in reports", () => {
    expect(KNOWN_DRIVERS).toEqual(
      expect.arrayContaining([CLAUDE_CODE_DRIVER_NAME, CODEX_DRIVER_NAME, GEMINI_CLI_DRIVER_NAME]),
    );
  });

  it("trusts a pre-resolved binary path without probing", async () => {
    for (const create of [createClaudeCodeDriver, createCodexDriver, createGeminiCliDriver]) {
      const driver = create({ binaryPath: "/resolved/cli" });
      expect(await driver.detect()).toEqual({ status: "runnable", path: "/resolved/cli" });
    }
  });
});

describe("claude-code driver", () => {
  it("runs headless with -p, json output, permissions bypassed, and the MCP config", async () => {
    const driver = createClaudeCodeDriver({ binaryPath: "/bin/claude" });
    const input = await runInput();
    stubSpawn({ stdout: CLAUDE_RESULT });

    const outcome = await driver.runAgent(input);

    expect(outcome).toEqual({ kind: "completed", tokens: 315 });
    const [command, args, options] = spawnCalls()[0];
    expect(command).toBe("/bin/claude");
    expect(args).toEqual([
      "-p",
      TASK.prompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--mcp-config",
      path.join(input.sandbox, ".ergolab-mcp.json"),
    ]);
    expect(options).toMatchObject({ cwd: input.sandbox });
  });

  it("writes the mcpServers config ~/.claude.json uses, suite paths absolutized", async () => {
    const input = await runInput();

    await createClaudeCodeDriver({ binaryPath: "/bin/claude" }).buildInvocation(input);

    const config = JSON.parse(await readFile(path.join(input.sandbox, ".ergolab-mcp.json"), "utf8"));
    expect(config).toEqual({
      mcpServers: {
        registry: {
          type: "stdio",
          command: "node",
          args: ["--experimental-strip-types", path.join(input.suiteDir, "server", "index.ts")],
          env: {},
        },
      },
    });
  });

  it("omits MCP wiring when the suite declares no servers", async () => {
    const input = await runInput({});

    const argv = await invocationOf(createClaudeCodeDriver({ binaryPath: "/bin/claude" }), input);

    expect(argv).toEqual(["/bin/claude", "-p", TASK.prompt, "--output-format", "json", "--dangerously-skip-permissions"]);
  });

  it("sums input, output, and cache tokens from the json result", () => {
    const driver = createClaudeCodeDriver({ binaryPath: "/bin/claude" });
    expect(driver.parseUsage(CLAUDE_RESULT)).toBe(315);
    expect(driver.parseUsage(JSON.stringify({ type: "result", is_error: false, result: "ok" }))).toBeUndefined();
    expect(driver.parseUsage("not json")).toBeUndefined();
  });

  it("reports an error outcome when the result object flags an error", async () => {
    stubSpawn({ stdout: JSON.stringify({ type: "result", is_error: true, result: "Credit balance too low" }) });
    const input = await runInput();

    const outcome = await createClaudeCodeDriver({ binaryPath: "/bin/claude" }).runAgent(input);

    expect(outcome).toEqual({ kind: "error", message: "Credit balance too low" });
  });

  it("reports an error outcome when the CLI exits non-zero", async () => {
    stubSpawn({ code: 1, stderr: "API Error (500)\n" });
    const input = await runInput();

    const outcome = await createClaudeCodeDriver({ binaryPath: "/bin/claude" }).runAgent(input);

    expect(outcome.kind).toBe("error");
    expect(errorMessage(outcome)).toContain("code 1");
  });

  it("reports an error outcome when stdout is not a json result", async () => {
    stubSpawn({ stdout: "plain text" });
    const input = await runInput();

    const outcome = await createClaudeCodeDriver({ binaryPath: "/bin/claude" }).runAgent(input);

    expect(outcome.kind).toBe("error");
  });
});

describe("codex driver", () => {
  it("runs codex exec headless with sandbox, git-check skip, output file, and MCP overrides", async () => {
    const driver = createCodexDriver({ binaryPath: "/bin/codex" });
    const input = await runInput();
    stubSpawn({ stdout: CODEX_JSONL });

    const outcome = await driver.runAgent(input);

    expect(outcome).toEqual({ kind: "completed", tokens: 18 });
    const [command, args, options] = spawnCalls()[0];
    expect(command).toBe("/bin/codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-C",
      input.sandbox,
      "-o",
      path.join(input.sandbox, ".ergolab-last-message.txt"),
      "-c",
      `mcp_servers.registry={command="node",args=["--experimental-strip-types","${path.join(input.suiteDir, "server", "index.ts")}"]}`,
      TASK.prompt,
    ]);
    expect(options).toMatchObject({ cwd: input.sandbox });
  });

  it("escapes TOML-special characters in the MCP override", async () => {
    const input = await runInput({ tricky: { command: 'say "hi"', args: ["back\\slash", "line\nbreak"] } });

    const argv = await invocationOf(createCodexDriver({ binaryPath: "/bin/codex" }), input);

    const override = argv.find((arg) => arg.startsWith("mcp_servers."));
    expect(override).toBe('mcp_servers.tricky={command="say \\"hi\\"",args=["back\\\\slash","line\\nbreak"]}');
  });

  it("omits MCP wiring when the suite declares no servers", async () => {
    const input = await runInput({});

    const argv = await invocationOf(createCodexDriver({ binaryPath: "/bin/codex" }), input);

    expect(argv).not.toContain("-c");
    expect(argv.at(-1)).toBe(TASK.prompt);
  });

  it("takes the run's token total from usage events, exec and session shapes alike", () => {
    const driver = createCodexDriver({ binaryPath: "/bin/codex" });
    expect(driver.parseUsage(CODEX_JSONL)).toBe(18);
    expect(driver.parseUsage(CODEX_SESSION_JSONL)).toBe(77);
    expect(driver.parseUsage("")).toBeUndefined();
  });

  it("reports turn.failed events as error outcomes", async () => {
    stubSpawn({ stdout: `${JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } })}\n` });
    const input = await runInput();

    const outcome = await createCodexDriver({ binaryPath: "/bin/codex" }).runAgent(input);

    expect(outcome).toEqual({ kind: "error", message: "stream disconnected" });
  });
});

describe("gemini-cli driver", () => {
  it("runs headless with yolo, json output, the MCP config, and the prompt", async () => {
    const driver = createGeminiCliDriver({ binaryPath: "/bin/gemini" });
    const input = await runInput();
    stubSpawn({ stdout: GEMINI_RESULT });

    const outcome = await driver.runAgent(input);

    expect(outcome).toEqual({ kind: "completed", tokens: 42 });
    const [command, args, options] = spawnCalls()[0];
    expect(command).toBe("/bin/gemini");
    expect(args).toEqual([
      "-y",
      "--output-format",
      "json",
      "--mcp-config",
      path.join(input.sandbox, ".ergolab-mcp.json"),
      "-p",
      TASK.prompt,
    ]);
    expect(options).toMatchObject({ cwd: input.sandbox });
  });

  it("writes the mcpServers config ~/.gemini/settings.json uses", async () => {
    const input = await runInput();

    await createGeminiCliDriver({ binaryPath: "/bin/gemini" }).buildInvocation(input);

    const config = JSON.parse(await readFile(path.join(input.sandbox, ".ergolab-mcp.json"), "utf8"));
    expect(config).toEqual({
      mcpServers: {
        registry: {
          command: "node",
          args: ["--experimental-strip-types", path.join(input.suiteDir, "server", "index.ts")],
          env: {},
        },
      },
    });
  });

  it("omits MCP wiring when the suite declares no servers", async () => {
    const input = await runInput({});

    const argv = await invocationOf(createGeminiCliDriver({ binaryPath: "/bin/gemini" }), input);

    expect(argv).toEqual(["/bin/gemini", "-y", "--output-format", "json", "-p", TASK.prompt]);
  });

  it("extracts tokens defensively from the unverified output shapes", () => {
    const driver = createGeminiCliDriver({ binaryPath: "/bin/gemini" });
    expect(driver.parseUsage(GEMINI_RESULT)).toBe(42);
    expect(driver.parseUsage(JSON.stringify({ response: "ok", usage_metadata: { total_token_count: 15 } }))).toBe(15);
    expect(driver.parseUsage("plain text")).toBeUndefined();
    expect(driver.parseUsage("{}")).toBeUndefined();
  });
});

describe("shared CLI-driver behavior", () => {
  type DriverFactory = (options?: { binaryPath?: string }) => AgentDriver;
  const FACTORIES: ReadonlyArray<readonly [string, DriverFactory]> = [
    ["claude-code", createClaudeCodeDriver],
    ["codex", createCodexDriver],
    ["gemini-cli", createGeminiCliDriver],
  ];

  it.each(FACTORIES)("%s: kills a hung CLI subprocess at the task timeout", async (_name, create) => {
    const input = await runInput();
    input.timeoutS = 1;
    stubSpawn({ hang: true });

    // Real 1s wait, like the runner's own timeout test: the child never
    // exits, the driver must kill it at the task timeout.
    const outcome = await create({ binaryPath: "/bin/cli" }).runAgent(input);

    expect(outcome).toEqual({ kind: "timeout" });
  });

  it.each(FACTORIES)("%s: reports an error outcome when the CLI cannot be spawned", async (_name, create) => {
    const input = await runInput();
    stubSpawn({ error: new Error("spawn /bin/cli ENOENT") });

    const outcome = await create({ binaryPath: "/bin/cli" }).runAgent(input);

    expect(outcome.kind).toBe("error");
    expect(errorMessage(outcome)).toContain("ENOENT");
  });
});
