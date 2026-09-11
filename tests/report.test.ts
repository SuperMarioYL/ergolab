import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mockDriver } from "../src/drivers/mock";
import { runSuite } from "../src/runner";
import {
  BADGE_FILENAME,
  MARKDOWN_FILENAME,
  REPORT_DIRNAME,
  renderBadge,
  renderFailureList,
  renderMarkdown,
  renderPanelTable,
  renderScorecard,
  writeReportArtifacts,
} from "../src/report";
import { PanelReportSchema, REPORT_FILENAME } from "../src/schema";
import type { PanelReport } from "../src/schema";
import { loadSuite } from "../src/suite";

const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ergolab-report-test-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

const fixture: PanelReport = {
  suite: "fixture-suite",
  generated_at: "2026-09-11T00:00:00.000Z",
  agents: [
    {
      driver: "mock",
      results: [
        { task: "alpha", status: "pass", stage: "verify", wall_ms: 1500, tokens: 24 },
        { task: "beta", status: "fail", stage: "verify", wall_ms: 900 },
        { task: "gamma", status: "timeout", stage: "agent", wall_ms: 60000 },
        { task: "delta", status: "error", stage: "setup", wall_ms: 10 },
      ],
    },
    { driver: "codex", skipped: "not-found", results: [] },
  ],
};

describe("renderPanelTable", () => {
  it("shows agents as rows and tasks as columns with per-cell outcomes", () => {
    const table = renderPanelTable(fixture);

    expect(table).toContain("mock");
    expect(table).toContain("codex");
    expect(table).toContain("skipped: not-found");
    expect(table).toContain("alpha");
    expect(table).toContain("pass");
    expect(table).toContain("1.5s");
  });

  it("degrades to a note when no agent ran a task", () => {
    const allSkipped: PanelReport = {
      ...fixture,
      agents: [{ driver: "codex", skipped: "not-found", results: [] }],
    };

    expect(renderPanelTable(allSkipped)).toContain("No agent ran a task.");
  });
});

describe("renderFailureList", () => {
  it("lists every non-pass result with its stage", () => {
    const list = renderFailureList(fixture);

    expect(list).toContain("beta");
    expect(list).toContain("fail");
    expect(list).toContain("gamma");
    expect(list).toContain("timeout");
    expect(list).toContain("delta");
    expect(list).toContain("setup");
  });

  it("is empty when every run passed", () => {
    const allPass: PanelReport = {
      ...fixture,
      agents: [
        {
          driver: "mock",
          results: [{ task: "alpha", status: "pass", stage: "verify", wall_ms: 1500 }],
        },
      ],
    };

    expect(renderFailureList(allPass)).toBe("");
  });
});

describe("renderScorecard", () => {
  it("summarizes per-agent pass counts and the panel total", () => {
    expect(renderScorecard(fixture)).toBe("Scorecard: mock 1/4 · codex skipped — panel 1/4 (25%)");
  });
});

describe("renderMarkdown", () => {
  it("renders the panel, failures, and scorecard sections", () => {
    const markdown = renderMarkdown(fixture);

    expect(markdown).toContain("# ErgoLab panel report — fixture-suite");
    expect(markdown).toContain("| agent | alpha | beta | gamma | delta |");
    expect(markdown).toContain("**pass** · 1.5s · 24t");
    expect(markdown).toContain("*(skipped: not-found)*");
    expect(markdown).toContain("| mock | beta | fail | verify |");
    expect(markdown).toContain("| mock | 1 | 1 | 1 | 1 | 25% |");
    expect(markdown).toContain("**Panel total: 1/4 runs pass (25%)**");
    expect(markdown).toContain("exit-code verification");
  });

  it("states a clean pass instead of an empty failure table", () => {
    const allPass: PanelReport = {
      ...fixture,
      agents: [
        {
          driver: "mock",
          results: [{ task: "alpha", status: "pass", stage: "verify", wall_ms: 1500 }],
        },
      ],
    };

    expect(renderMarkdown(allPass)).toContain("All runs passed.");
  });
});

describe("renderBadge", () => {
  it("maps the panel score onto the shields.io endpoint format", () => {
    expect(renderBadge(fixture)).toEqual({
      schemaVersion: 1,
      label: "agent-usability",
      message: "25/100",
      color: "orange",
    });
  });

  it("colors by score band", () => {
    const badge = (passes: number, total: number): string =>
      renderBadge({
        ...fixture,
        agents: [
          {
            driver: "mock",
            results: Array.from({ length: total }, (_, index) => ({
              task: `t${index}`,
              status: index < passes ? ("pass" as const) : ("fail" as const),
              stage: "verify" as const,
              wall_ms: 1,
            })),
          },
        ],
      }).color;

    expect(badge(10, 10)).toBe("brightgreen");
    expect(badge(7, 10)).toBe("green");
    expect(badge(4, 10)).toBe("yellow");
    expect(badge(1, 10)).toBe("orange");
    expect(badge(0, 10)).toBe("red");
  });

  it("says so when no agent ran", () => {
    expect(renderBadge({ ...fixture, agents: [{ driver: "codex", skipped: "not-found", results: [] }] })).toEqual({
      schemaVersion: 1,
      label: "agent-usability",
      message: "no agents ran",
      color: "lightgrey",
    });
  });
});

describe("writeReportArtifacts", () => {
  it("writes ergolab-report.json, report/report.md, and badge.json", async () => {
    const outDir = await scratchDir();

    await writeReportArtifacts(fixture, outDir);

    const reportJson = JSON.parse(await readFile(path.join(outDir, REPORT_FILENAME), "utf8"));
    expect(PanelReportSchema.parse(reportJson)).toEqual(fixture);

    const markdown = await readFile(path.join(outDir, REPORT_DIRNAME, MARKDOWN_FILENAME), "utf8");
    expect(markdown).toContain("fixture-suite");

    const badge = JSON.parse(await readFile(path.join(outDir, BADGE_FILENAME), "utf8"));
    expect(badge).toEqual({ schemaVersion: 1, label: "agent-usability", message: "25/100", color: "orange" });
  });
});

describe("bundled suites end to end with the mock driver", () => {
  it("produces the deterministic grep-arm result on the showcase suite", async () => {
    const suite = await loadSuite(path.join(repoRoot, "suites", "showcase-grep-vs-tool"));

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(report.suite).toBe("showcase-grep-vs-tool");
    expect(report.agents[0].results.map((result) => result.status)).toEqual([
      "pass",
      "pass",
      "fail",
      "fail",
      "fail",
      "fail",
    ]);
    expect(renderBadge(report).message).toBe("33/100");

    const outDir = await scratchDir();
    await writeReportArtifacts(report, outDir);
    const markdown = await readFile(path.join(outDir, REPORT_DIRNAME, MARKDOWN_FILENAME), "utf8");
    expect(markdown).toContain("**pass** ·");
    expect(markdown).toContain("find-latest-version");
  });

  it("shows the affordance gap on the demo-mcp suite: no tool access, no pass", async () => {
    const suite = await loadSuite(path.join(repoRoot, "suites", "demo-mcp"));

    const report = await runSuite({ suite, drivers: [mockDriver], sandboxRoot: await scratchDir() });

    expect(report.suite).toBe("demo-mcp");
    for (const result of report.agents[0].results) {
      expect(result.status).toBe("fail");
      expect(result.stage).toBe("verify");
    }
    expect(renderBadge(report)).toMatchObject({ message: "0/100", color: "red" });
  });
});
