/**
 * The ergolab CLI: init · run · list-suites · showcase · report.
 *
 * One process, no services. Every command is thin orchestration over the
 * library core — suite loading (src/suite.ts), the panel runner
 * (src/runner.ts), the reporter (src/report.ts), and binary discovery
 * (src/drivers/detect.ts). The run command is the product's happy path:
 * resolve the suite, resolve the panel (the mock baseline plus every
 * agent CLI whose binary discovery finds — skipped agents keep their
 * rows), run sequentially, print the panel table, and write
 * ergolab-report.json, report/report.md, and badge.json.
 */
import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import { createClaudeCodeDriver } from "./drivers/claude-code";
import { createCodexDriver } from "./drivers/codex";
import { resolveDriverCli, type CliDriverName } from "./drivers/detect";
import { createGeminiCliDriver } from "./drivers/gemini-cli";
import { mockDriver } from "./drivers/mock";
import type { AgentDriver, CliDriverOptions, CliResolution } from "./drivers/types";
import {
  BADGE_FILENAME,
  MARKDOWN_FILENAME,
  REPORT_DIRNAME,
  colorFor,
  formatWall,
  renderFailureList,
  renderPanelTable,
  renderScorecard,
  writeReportArtifacts,
} from "./report";
import { runSuite, type PanelMember } from "./runner";
import { KNOWN_DRIVERS, PanelReportSchema, REPORT_FILENAME, SUITE_FILENAME, type PanelReport, type TaskResult } from "./schema";
import { loadSuite } from "./suite";

/** The package version, from the package.json that ships beside dist/. */
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** Bundled suites: the suites/ directory shipped with the package. */
const BUNDLED_SUITES_DIR = fileURLToPath(new URL("../suites", import.meta.url));

/** The bundled grep arm of the A/B pair the showcase command runs. */
const SHOWCASE_SUITE = "showcase-grep-vs-tool";

/** The default panel: the mock baseline first, then every agent CLI. */
const DEFAULT_AGENTS: readonly string[] = ["mock", "claude-code", "codex", "gemini-cli"];

// -- suite discovery ----------------------------------------------------------

/** A suite the CLI can run, as list-suites shows it. */
export interface SuiteListing {
  /** Suite name (directory basename) — the name `run` accepts. */
  readonly name: string;
  readonly source: "bundled" | "local";
  readonly dir: string;
  /** The tool under test, or the load error when the suite is invalid. */
  readonly tool: string;
  readonly tasks: number;
}

function isSuiteDir(dir: string): boolean {
  return existsSync(path.join(dir, SUITE_FILENAME));
}

/**
 * Resolve a suite reference to a suite directory: an explicit path (a
 * directory containing ergolab.yaml, or the yaml file itself) first,
 * then a directory of that name in the working directory, then the
 * bundled suites. Local directories shadow bundled names.
 */
export function resolveSuiteDir(ref: string): string | undefined {
  const asPath = path.resolve(ref);
  if (isSuiteDir(asPath)) return asPath;
  if (path.basename(asPath) === SUITE_FILENAME && existsSync(asPath)) return path.dirname(asPath);
  const asBundled = path.join(BUNDLED_SUITES_DIR, ref);
  if (isSuiteDir(asBundled)) return asBundled;
  return undefined;
}

/** Load one listing, or record the load error in place of the tool name. */
async function listingFor(name: string, source: "bundled" | "local", dir: string): Promise<SuiteListing> {
  try {
    const loaded = await loadSuite(dir);
    return { name, source, dir, tool: loaded.suite.tool, tasks: loaded.suite.tasks.length };
  } catch (error) {
    return { name, source, dir, tool: `invalid: ${(error as Error).message.split("\n")[0]}`, tasks: 0 };
  }
}

/** Every suite the CLI can see from here: local ones first, then bundled. */
export async function collectSuites(): Promise<SuiteListing[]> {
  const listings: Promise<SuiteListing>[] = [];

  const cwd = process.cwd();
  if (isSuiteDir(cwd)) listings.push(listingFor(path.basename(cwd), "local", cwd));
  const localRoot = path.join(cwd, "suites");
  if (existsSync(localRoot)) {
    for (const name of readdirSync(localRoot).sort()) {
      const dir = path.join(localRoot, name);
      if (isSuiteDir(dir)) listings.push(listingFor(name, "local", dir));
    }
  }
  for (const name of readdirSync(BUNDLED_SUITES_DIR).sort()) {
    const dir = path.join(BUNDLED_SUITES_DIR, name);
    if (isSuiteDir(dir)) listings.push(listingFor(name, "bundled", dir));
  }

  return Promise.all(listings);
}

// -- panel assembly -------------------------------------------------------------

/** One panel row as the run command resolved it. */
export interface PanelEntry {
  /** The member handed to the runner: a driver, or a skipped agent. */
  readonly member: PanelMember;
  /** How the CLI driver's binary resolved; undefined for the mock driver. */
  readonly resolution?: CliResolution;
}

/** The CLI drivers this module can add to a panel. */
const CLI_DRIVERS: Record<CliDriverName, (options: CliDriverOptions) => AgentDriver> = {
  "claude-code": createClaudeCodeDriver,
  codex: createCodexDriver,
  "gemini-cli": createGeminiCliDriver,
};

/**
 * Build the run panel from agent names. The mock driver joins when
 * listed; each CLI driver joins when its binary resolves — otherwise its
 * row is kept as skipped with the reason detect() reported. Unknown
 * names are rejected before anything runs. `detect` is injectable so
 * callers that already know the answer (tests) need no binaries.
 */
export function buildPanel(
  agentNames: readonly string[],
  detect: (driver: CliDriverName) => CliResolution = resolveDriverCli,
): PanelEntry[] {
  for (const name of agentNames) {
    if (!KNOWN_DRIVERS.includes(name as (typeof KNOWN_DRIVERS)[number])) {
      throw new Error(`unknown agent "${name}" (known agents: ${KNOWN_DRIVERS.join(", ")})`);
    }
  }

  const entries: PanelEntry[] = [];
  for (const name of agentNames) {
    if (name === "mock") {
      entries.push({ member: mockDriver });
      continue;
    }
    const resolution = detect(name as CliDriverName); // validated above
    if (resolution.status === "skipped") {
      entries.push({ member: { name, skipped: resolution.reason }, resolution });
      continue;
    }
    entries.push({ member: CLI_DRIVERS[name as CliDriverName]({ binaryPath: resolution.path }), resolution });
  }
  return entries;
}

/** Split an --agents value into names; the default panel when absent. */
function parseAgents(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_AGENTS];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new Error(`--agents needs at least one agent (known agents: ${KNOWN_DRIVERS.join(", ")})`);
  }
  return names;
}

// -- command output ----------------------------------------------------------------

/** The readiness lines: who runs, from where, and who is skipped with why. */
function printPanelEntry(entry: PanelEntry): void {
  const name = entry.member.name;
  if (entry.resolution?.status === "skipped") {
    console.log(`  ${pc.bold(name)}  ${pc.yellow(`skipped (${entry.resolution.reason})`)}`);
    return;
  }
  const detail = entry.resolution === undefined ? "deterministic baseline" : entry.resolution.path;
  console.log(`  ${pc.bold(name)}  ${pc.green("ready")} ${pc.dim(detail)}`);
}

/** One line per finished cell, as the panel fills in. */
function printTaskResult(agent: string, result: TaskResult): void {
  const tokens = result.tokens === undefined ? "" : ` · ${result.tokens}t`;
  console.log(
    `  ${pc.bold(agent)} · ${result.task.padEnd(22)} ${colorFor(result.status)(result.status)} · ${result.stage} · ${formatWall(result.wall_ms)}${tokens}`,
  );
}

/** The findings: panel table, failure list, scorecard, artifact paths. */
function printFindings(report: PanelReport, outDir: string): void {
  console.log();
  console.log(renderPanelTable(report));
  const failures = renderFailureList(report);
  if (failures !== "") console.log(failures);
  console.log(renderScorecard(report));
  console.log();
  console.log(
    `Artifacts: ${path.join(outDir, REPORT_FILENAME)} · ${path.join(outDir, REPORT_DIRNAME, MARKDOWN_FILENAME)} · ${path.join(outDir, BADGE_FILENAME)}`,
  );
}

// -- the scaffold ergolab init writes ----------------------------------------------

/** The starter suite `ergolab init` scaffolds: three runnable tasks. */
const SCAFFOLD_YAML = `# ErgoLab task suite — scaffolded by \`ergolab init\`.
#
# One suite is the test plan for ONE tool. Each task runs in a fresh
# sandbox: setup prepares it, the agent answers the prompt, and verify —
# a shell command — decides the outcome (exit 0 = pass, no LLM judge).
# The suite is runnable as-is: the first task passes even with the
# keyless mock agent, the other two fail it — your baseline to beat.
#
# Register an MCP server for every agent (optional; suite-relative paths):
#
# mcp_servers:
#   my-server:
#     command: node
#     args: [server/index.ts]

tool: my-tool

tasks:
  # A lookup task: the answer is greppable in the sandbox, so even the
  # mock agent (a grep-only stand-in) passes it.
  - name: lookup-answer
    setup: "echo 'ergolab 42' > facts.txt"
    prompt: "Find the number associated with \`ergolab\` in facts.txt and write it to answer.txt."
    verify: "grep -q 42 answer.txt"

  # A tool task: the answer lives behind YOUR tool (CLI, library, MCP
  # server). Name one of its real operations here — the mock agent fails
  # this by design; real agents are what you measure.
  - name: use-the-tool
    setup: "echo 'input data' > input.txt"
    prompt: "Use the tool to process \`input.txt\` and write the result to answer.txt."
    verify: "test -s answer.txt"

  # A docs task: can an agent follow your documentation alone? Seed the
  # sandbox with the docs it needs (here: a stub README to replace).
  - name: follow-the-docs
    setup: "printf '# My Tool\\n\\nUsage: my-tool <input>\\n' > README.md"
    prompt: "Following README.md, run the tool on the sandbox's input and write its final output to answer.txt."
    verify: "test -s answer.txt"
`;

// -- the commands ---------------------------------------------------------------------

/** Options run and showcase share. */
interface RunOptions {
  agents?: string;
  out?: string;
}

async function runCommand(ref: string, options: RunOptions): Promise<void> {
  const dir = resolveSuiteDir(ref);
  if (dir === undefined) {
    throw new Error(`no suite "${ref}" — pass a suite directory or a bundled name (see ergolab list-suites)`);
  }
  const loaded = await loadSuite(dir);
  const agentNames = parseAgents(options.agents);
  const panel = buildPanel(agentNames);
  const outDir = path.resolve(options.out ?? ".");

  console.log(pc.bold(`ErgoLab ${PACKAGE_VERSION} — suite ${loaded.name} (${loaded.suite.tool}, ${loaded.suite.tasks.length} tasks)`));
  console.log();
  for (const entry of panel) printPanelEntry(entry);
  console.log();

  const report = await runSuite({
    suite: loaded,
    drivers: panel.map((entry) => entry.member),
    sandboxRoot: path.join(outDir, "sandbox"),
    onTaskResult: printTaskResult,
  });

  await writeReportArtifacts(report, outDir);
  printFindings(report, outDir);
  console.log(`Sandbox:   ${path.join(outDir, "sandbox")}`);
}

async function initCommand(): Promise<void> {
  const target = path.join(process.cwd(), SUITE_FILENAME);
  if (existsSync(target)) {
    throw new Error(`${SUITE_FILENAME} already exists here — not overwriting it`);
  }
  await writeFile(target, SCAFFOLD_YAML);
  console.log(`Wrote ${target} — three runnable starter tasks.`);
  console.log();
  console.log("Next: edit the prompts to name your tool's operations, then:");
  console.log("  ergolab run . --agents mock   # keyless baseline, no agent CLI needed");
  console.log("  ergolab run .                 # every agent CLI discovered on this machine");
}

async function listSuitesCommand(): Promise<void> {
  const suites = await collectSuites();
  const table = new Table({ head: ["suite", "source", "tool", "tasks"] });
  for (const suite of suites) {
    table.push([suite.name, suite.source, suite.tool, String(suite.tasks)]);
  }
  console.log(table.toString());
}

async function showcaseCommand(options: RunOptions): Promise<void> {
  await runCommand(SHOWCASE_SUITE, options);
}

async function reportCommand(file: string, options: { out?: string }): Promise<void> {
  const resolved = path.resolve(file);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`cannot read a JSON report at ${resolved}: ${(error as Error).message}`);
  }
  const parsed = PanelReportSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${(issue.path.join(".") || "(root)")}: ${issue.message}`)
      .join("\n");
    throw new Error(`${resolved} is not a valid panel report:\n${issues}`);
  }

  const outDir = path.resolve(options.out ?? path.dirname(resolved));
  await writeReportArtifacts(parsed.data, outDir);
  printFindings(parsed.data, outDir);
}

// -- wiring -----------------------------------------------------------------------------

/** The ergolab command tree; exported so tests drive it without a process. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ergolab")
    .description("A usability lab for tools built for coding agents")
    .version(PACKAGE_VERSION);

  program
    .command("init")
    .description("scaffold an ergolab.yaml with three runnable starter tasks in the current directory")
    .action(initCommand);

  program
    .command("run")
    .description("run a task suite against a panel of agents (default: mock + every discovered agent CLI)")
    .argument("<suite>", "suite directory or bundled suite name")
    .option("--agents <agents>", `comma-separated panel (${KNOWN_DRIVERS.join(", ")})`)
    .option("--out <dir>", "output directory for report artifacts and sandboxes (default: current directory)")
    .action(runCommand);

  program
    .command("list-suites")
    .description("list bundled suites and any found in the current directory")
    .action(listSuitesCommand);

  program
    .command("showcase")
    .description("run the bundled grep-vs-tool showcase suite (the grep arm of the A/B pair)")
    .option("--agents <agents>", `comma-separated panel (${KNOWN_DRIVERS.join(", ")})`)
    .option("--out <dir>", "output directory for report artifacts and sandboxes (default: current directory)")
    .action(showcaseCommand);

  program
    .command("report")
    .description("re-render a saved ergolab-report.json")
    .argument("[file]", "path to an ergolab-report.json", "ergolab-report.json")
    .option("--out <dir>", "where to write report/report.md and badge.json (default: beside the report file)")
    .action(reportCommand);

  return program;
}

/** True when this module is the process entry (node dist/cli.js, npx ergolab). */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`ergolab: ${message}`));
      process.exitCode = 1;
    });
}
