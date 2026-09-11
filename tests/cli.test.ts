/**
 * Tests for the ergolab CLI.
 *
 * Command wiring is driven through buildProgram().parseAsync — the same
 * path the bin entry takes — against real temp directories: init's
 * scaffold, run/report/list-suites/showcase end to end with the
 * deterministic mock driver, suite resolution (path, local, bundled),
 * panel assembly (binary injection and skip rows), and the error paths.
 * No agent CLI is ever invoked.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPanel, buildProgram, collectSuites, resolveSuiteDir } from "../src/cli";
import { resolveDriverCli, type CliDriverName } from "../src/drivers/detect";
import { mockDriver } from "../src/drivers/mock";
import type { AgentDriver, CliResolution } from "../src/drivers/types";
import { BADGE_FILENAME } from "../src/report";
import { PanelReportSchema, REPORT_FILENAME, SUITE_FILENAME } from "../src/schema";

/** A CLI driver as buildPanel returns it: runnable, with its detect seam. */
type DetectableDriver = AgentDriver & { detect(): Promise<CliResolution> };

const scratchDirs: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Run a command the way the bin entry does. */
async function cli(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(args, { from: "user" });
}

/** Run `body` from `dir`; always restores the previous working directory. */
async function withCwd<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(previous);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

/** Silence and capture console.log lines for one command invocation. */
function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

/** A resolution injection that finds every CLI at a fixed path. */
const foundEverywhere = (file: string) => (): CliResolution => ({ status: "runnable", path: file });

describe("buildPanel — panel assembly", () => {
  it("adds the mock driver as a plain member", () => {
    const panel = buildPanel(["mock"]);
    expect(panel).toEqual([{ member: mockDriver }]);
  });

  it("injects a resolved binary path into each runnable CLI driver", async () => {
    const panel = buildPanel(["claude-code", "codex", "gemini-cli"], foundEverywhere("/bin/agent"));

    expect(panel.map((entry) => entry.member.name)).toEqual(["claude-code", "codex", "gemini-cli"]);
    for (const entry of panel) {
      expect(entry.resolution).toEqual({ status: "runnable", path: "/bin/agent" });
      // binaryPath injection: no probing happened, the path is the one given.
      expect(await (entry.member as DetectableDriver).detect()).toEqual({
        status: "runnable",
        path: "/bin/agent",
      });
    }
  });

  it("keeps a skipped row for every agent whose binary cannot run", () => {
    const notFound = (): CliResolution => ({ status: "skipped", reason: "not-found" });

    const panel = buildPanel(["mock", "claude-code", "gemini-cli"], notFound);

    expect(panel.map((entry) => entry.member)).toEqual([
      mockDriver,
      { name: "claude-code", skipped: "not-found" },
      { name: "gemini-cli", skipped: "not-found" },
    ]);
  });

  it("carries each agent's own skip reason into its row", () => {
    const detect = (driver: CliDriverName): CliResolution =>
      driver === "codex"
        ? { status: "skipped", reason: "off-path-at /Applications/ChatGPT.app/Contents/Resources/codex" }
        : { status: "skipped", reason: "not-found" };

    const panel = buildPanel(["codex", "gemini-cli"], detect);

    expect(panel.map((entry) => entry.member)).toEqual([
      { name: "codex", skipped: "off-path-at /Applications/ChatGPT.app/Contents/Resources/codex" },
      { name: "gemini-cli", skipped: "not-found" },
    ]);
  });

  it("rejects unknown agent names before anything runs", () => {
    expect(() => buildPanel(["mock", "aider"])).toThrow(/unknown agent "aider"/);
  });

  it("defaults to real binary discovery when no detector is injected", () => {
    // With no binaries on an empty PATH every CLI resolves as not-found;
    // the mock driver still joins.
    const panel = buildPanel(["mock"], (driver) => resolveDriverCli(driver, "/nowhere-on-path"));
    expect(panel).toEqual([{ member: mockDriver }]);
  });
});

describe("suite resolution", () => {
  it("accepts a suite directory path", async () => {
    const dir = await scratchDir("ergolab-cli-suite-");
    await writeFile(path.join(dir, SUITE_FILENAME), "tool: t\ntasks:\n  - name: a\n    prompt: p\n    verify: true\n");

    expect(resolveSuiteDir(dir)).toBe(path.resolve(dir));
  });

  it("accepts a path to the ergolab.yaml file itself", async () => {
    const dir = await scratchDir("ergolab-cli-suite-");
    await writeFile(path.join(dir, SUITE_FILENAME), "tool: t\ntasks:\n  - name: a\n    prompt: p\n    verify: true\n");

    expect(resolveSuiteDir(path.join(dir, SUITE_FILENAME))).toBe(path.resolve(dir));
  });

  it("resolves bundled suite names", () => {
    const dir = resolveSuiteDir("demo-mcp");
    expect(dir).toBeDefined();
    expect(dir?.endsWith(path.join("suites", "demo-mcp"))).toBe(true);
    expect(resolveSuiteDir("showcase-grep-vs-tool")).toBeDefined();
  });

  it("returns undefined for a suite that exists nowhere", () => {
    expect(resolveSuiteDir("no-such-suite")).toBeUndefined();
  });
});

describe("init", () => {
  it("scaffolds a valid three-task suite that runs end to end with the mock agent", async () => {
    captureLog();
    const repo = await scratchDir("ergolab-cli-init-");
    const out = await scratchDir("ergolab-cli-init-out-");

    await withCwd(repo, () => cli("init"));
    expect(existsSync(path.join(repo, SUITE_FILENAME))).toBe(true);

    await cli("run", repo, "--agents", "mock", "--out", out);

    const report = PanelReportSchema.parse(JSON.parse(await readFile(path.join(out, REPORT_FILENAME), "utf8")));
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]?.driver).toBe("mock");
    // The scaffold's own contract: one greppable pass, two affordance fails.
    expect(report.agents[0]?.results.map((result) => result.status)).toEqual(["pass", "fail", "fail"]);
  });

  it("refuses to overwrite an existing ergolab.yaml", async () => {
    captureLog();
    const repo = await scratchDir("ergolab-cli-init-twice-");
    await writeFile(path.join(repo, SUITE_FILENAME), "tool: keep\ntasks:\n  - name: a\n    prompt: p\n    verify: true\n");

    await expect(withCwd(repo, () => cli("init"))).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(repo, SUITE_FILENAME), "utf8")).toContain("tool: keep");
  });
});

describe("run", () => {
  it("runs the bundled showcase suite with the mock agent and writes every artifact", async () => {
    captureLog();
    const out = await scratchDir("ergolab-cli-run-out-");

    await cli("showcase", "--agents", "mock", "--out", out);

    const report = PanelReportSchema.parse(JSON.parse(await readFile(path.join(out, REPORT_FILENAME), "utf8")));
    expect(report.suite).toBe("showcase-grep-vs-tool");
    expect(report.agents[0]?.results.map((result) => result.status)).toEqual([
      "pass",
      "pass",
      "fail",
      "fail",
      "fail",
      "fail",
    ]);
    for (const artifact of [REPORT_FILENAME, "report/report.md", BADGE_FILENAME, "sandbox/mock"]) {
      expect(existsSync(path.join(out, artifact))).toBe(true);
    }
  });

  it("runs a local suite by directory path", async () => {
    captureLog();
    const dir = await scratchDir("ergolab-cli-local-suite-");
    const out = await scratchDir("ergolab-cli-local-out-");
    await writeFile(
      path.join(dir, SUITE_FILENAME),
      'tool: t\ntasks:\n  - name: lookup\n    setup: "echo \'hello 42\' > data.txt"\n    prompt: "Find `hello` and write it to answer.txt."\n    verify: "grep -q 42 answer.txt"\n',
    );

    await cli("run", dir, "--agents", "mock", "--out", out);

    const report = PanelReportSchema.parse(JSON.parse(await readFile(path.join(out, REPORT_FILENAME), "utf8")));
    expect(report.agents[0]?.results[0]?.status).toBe("pass");
  });

  it("rejects a suite reference that exists nowhere", async () => {
    captureLog();
    await expect(cli("run", "no-such-suite", "--agents", "mock")).rejects.toThrow(/no suite "no-such-suite"/);
  });

  it("rejects an invalid --agents value", async () => {
    captureLog();
    await expect(cli("run", "demo-mcp", "--agents", "aider")).rejects.toThrow(/unknown agent "aider"/);
    await expect(cli("run", "demo-mcp", "--agents", " ")).rejects.toThrow(/--agents needs at least one agent/);
  });

  it("reports a suite that fails schema validation with its issues", async () => {
    captureLog();
    const dir = await scratchDir("ergolab-cli-invalid-");
    await writeFile(path.join(dir, SUITE_FILENAME), "tool: t\ntasks: []\n");

    await expect(cli("run", dir, "--agents", "mock")).rejects.toThrow(/not a valid task suite/);
  });
});

describe("list-suites", () => {
  it("lists bundled suites plus local ones, bundled names shadowable", async () => {
    const lines = captureLog();
    const repo = await scratchDir("ergolab-cli-list-");
    await mkdir(path.join(repo, "suites", "my-suite"), { recursive: true });
    await writeFile(
      path.join(repo, "suites", "my-suite", SUITE_FILENAME),
      "tool: my-tool\ntasks:\n  - name: a\n    prompt: p\n    verify: true\n",
    );

    await withCwd(repo, () => cli("list-suites"));

    const rendered = lines.join("\n");
    expect(rendered).toContain("demo-mcp");
    expect(rendered).toContain("showcase-grep-vs-tool");
    expect(rendered).toContain("my-suite");
    expect(rendered).toContain("bundled");
    expect(rendered).toContain("local");
  });

  it("collectSuites exposes the same rows for programmatic use", async () => {
    const repo = await scratchDir("ergolab-cli-collect-");
    await withCwd(repo, async () => {
      const suites = await collectSuites();
      const names = suites.filter((suite) => suite.source === "bundled").map((suite) => suite.name);
      expect(names).toEqual(["demo-mcp", "showcase-grep-vs-tool"]);
    });
  });
});

describe("report", () => {
  it("re-renders a saved ergolab-report.json into a fresh out dir", async () => {
    captureLog();
    const out = await scratchDir("ergolab-cli-report-src-");
    const reOut = await scratchDir("ergolab-cli-report-out-");
    await cli("showcase", "--agents", "mock", "--out", out);

    await cli("report", path.join(out, REPORT_FILENAME), "--out", reOut);

    const report = PanelReportSchema.parse(JSON.parse(await readFile(path.join(reOut, REPORT_FILENAME), "utf8")));
    expect(report.suite).toBe("showcase-grep-vs-tool");
    for (const artifact of [REPORT_FILENAME, "report/report.md", BADGE_FILENAME]) {
      expect(existsSync(path.join(reOut, artifact))).toBe(true);
    }
  });

  it("rejects a file that is not a panel report", async () => {
    captureLog();
    const dir = await scratchDir("ergolab-cli-report-bad-");
    const file = path.join(dir, REPORT_FILENAME);
    await writeFile(file, '{"nonsense": true}');

    await expect(cli("report", file)).rejects.toThrow(/not a valid panel report/);
  });

  it("rejects a file that is not JSON at all", async () => {
    captureLog();
    const dir = await scratchDir("ergolab-cli-report-json-");
    const file = path.join(dir, REPORT_FILENAME);
    await writeFile(file, "not json");

    await expect(cli("report", file)).rejects.toThrow(/cannot read a JSON report/);
  });
});
