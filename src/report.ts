/**
 * The Reporter: render one PanelReport for humans and machines.
 *
 * Three surfaces, one input:
 *
 *   - the terminal — the agents-by-tasks panel table, the failure list
 *     (where each run stopped, and at which stage), and a one-line
 *     scorecard;
 *   - report/report.md — the same findings as a Markdown table set;
 *   - ergolab-report.json and badge.json — the machine copies: the raw
 *     report, and a self-hosted shields.io endpoint badge. Reports stay
 *     in the user's repo; there is no registry.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Table from "cli-table3";
import pc from "picocolors";
import { REPORT_FILENAME } from "./schema";
import type { AgentReport, PanelReport, TaskResult } from "./schema";

/** Directory (under the output dir) that holds the Markdown report. */
export const REPORT_DIRNAME = "report";
/** Markdown report file name, written inside REPORT_DIRNAME. */
export const MARKDOWN_FILENAME = "report.md";
/** shields.io endpoint JSON, self-hosted in the user's repo. */
export const BADGE_FILENAME = "badge.json";

/** The shields.io "endpoint" badge format (https://shields.io/endpoint). */
export interface BadgeJson {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

const BADGE_LABEL = "agent-usability";

/** Statuses that count as "did not pass" for the failure list. */
function isFailure(result: TaskResult): boolean {
  return result.status !== "pass";
}

function colorFor(status: TaskResult["status"]): (text: string) => string {
  switch (status) {
    case "pass":
      return pc.green;
    case "fail":
      return pc.red;
    case "timeout":
      return pc.yellow;
    case "error":
      return pc.magenta;
  }
}

function formatWall(wallMs: number): string {
  return wallMs < 1000 ? `${wallMs}ms` : `${(wallMs / 1000).toFixed(1)}s`;
}

/** Markdown cell: bold status with the timing and token cost appended. */
function cellMarkdown(result: TaskResult): string {
  const details = [formatWall(result.wall_ms)];
  if (result.tokens !== undefined) details.push(`${result.tokens}t`);
  return `**${result.status}** · ${details.join(" · ")}`;
}

/**
 * Task columns for the panel table: the first agent that actually ran
 * defines the order (skipped agents have no results to offer).
 */
function taskColumns(report: PanelReport): string[] {
  for (const agent of report.agents) {
    if (agent.skipped === undefined && agent.results.length > 0) {
      return agent.results.map((result) => result.task);
    }
  }
  return [];
}

function passesOf(agent: AgentReport): number {
  return agent.results.filter((result) => result.status === "pass").length;
}

/** Panel totals over agents that ran; skipped agents are not scored. */
function panelTotals(report: PanelReport): { passes: number; total: number } {
  let passes = 0;
  let total = 0;
  for (const agent of report.agents) {
    if (agent.skipped !== undefined) continue;
    passes += passesOf(agent);
    total += agent.results.length;
  }
  return { passes, total };
}

function percent(part: number, whole: number): number {
  return Math.round((part / whole) * 100);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The agents-by-tasks grid: agents as rows, tasks as columns. */
export function renderPanelTable(report: PanelReport): string {
  const columns = taskColumns(report);
  if (columns.length === 0) return "No agent ran a task.";

  const table = new Table({ head: ["agent", ...columns] });
  for (const agent of report.agents) {
    if (agent.skipped !== undefined) {
      table.push([pc.gray(`${agent.driver} (skipped: ${agent.skipped})`), ...columns.map(() => pc.gray("—"))]);
      continue;
    }
    table.push([
      agent.driver,
      ...agent.results.map((result) => `${colorFor(result.status)(result.status)} ${formatWall(result.wall_ms)}`),
    ]);
  }
  return table.toString();
}

/** Every non-pass result as agent/task/status/stage; empty string when all passed. */
export function renderFailureList(report: PanelReport): string {
  const failures = report.agents.flatMap((agent) =>
    agent.results.filter(isFailure).map((result) => ({ agent: agent.driver, result })),
  );
  if (failures.length === 0) return "";

  const table = new Table({ head: ["agent", "task", "status", "stage"] });
  for (const { agent, result } of failures) {
    table.push([agent, result.task, colorFor(result.status)(result.status), result.stage]);
  }
  return table.toString();
}

/** One line, e.g. "Scorecard: mock 2/6 · codex skipped — panel 2/12 (17%)". */
export function renderScorecard(report: PanelReport): string {
  const perAgent = report.agents.map((agent) =>
    agent.skipped !== undefined
      ? `${agent.driver} skipped`
      : `${agent.driver} ${passesOf(agent)}/${agent.results.length}`,
  );

  const { passes, total } = panelTotals(report);
  const overall = total > 0 ? `panel ${passes}/${total} (${percent(passes, total)}%)` : "panel 0/0";
  return `Scorecard: ${perAgent.join(" · ")} — ${overall}`;
}

/** The Markdown report written to report/report.md. */
export function renderMarkdown(report: PanelReport): string {
  const columns = taskColumns(report);
  const { passes, total } = panelTotals(report);
  const lines: string[] = [
    `# ErgoLab panel report — ${report.suite}`,
    "",
    `Generated ${report.generated_at} · ${plural(report.agents.length, "agent")} · ${plural(columns.length, "task")}`,
    "",
    "## Panel",
    "",
  ];

  if (columns.length === 0) {
    lines.push("No agent ran a task.");
  } else {
    lines.push(`| agent | ${columns.join(" | ")} |`);
    lines.push(`| --- | ${columns.map(() => "---").join(" | ")} |`);
    for (const agent of report.agents) {
      if (agent.skipped !== undefined) {
        lines.push(`| ${agent.driver} *(skipped: ${agent.skipped})* | ${columns.map(() => "—").join(" | ")} |`);
        continue;
      }
      lines.push(`| ${agent.driver} | ${agent.results.map(cellMarkdown).join(" | ")} |`);
    }
  }

  lines.push("", "## Failures", "");
  const failures = report.agents.flatMap((agent) =>
    agent.results.filter(isFailure).map((result) => ({ agent: agent.driver, result })),
  );
  if (failures.length === 0) {
    lines.push("All runs passed.");
  } else {
    lines.push("| agent | task | status | stage |", "| --- | --- | --- | --- |");
    for (const { agent, result } of failures) {
      lines.push(`| ${agent} | ${result.task} | ${result.status} | ${result.stage} |`);
    }
  }

  lines.push("", "## Scorecard", "", "| agent | pass | fail | timeout | error | score |", "| --- | --- | --- | --- | --- | --- |");
  for (const agent of report.agents) {
    if (agent.skipped !== undefined) {
      lines.push(`| ${agent.driver} | — | — | — | — | skipped |`);
      continue;
    }
    const count = (status: TaskResult["status"]): number => agent.results.filter((r) => r.status === status).length;
    const score = agent.results.length > 0 ? `${percent(passesOf(agent), agent.results.length)}%` : "0/0";
    lines.push(`| ${agent.driver} | ${count("pass")} | ${count("fail")} | ${count("timeout")} | ${count("error")} | ${score} |`);
  }

  if (total > 0) {
    lines.push(
      "",
      `**Panel total: ${passes}/${total} runs pass (${percent(passes, total)}%)** — sequential single-sample runs; this surfaces cliffs, not fine differences.`,
    );
  }
  lines.push("", "_Generated by ErgoLab · exit-code verification, no LLM judge._", "");
  return lines.join("\n");
}

/** The self-hosted shields.io endpoint badge for this report. */
export function renderBadge(report: PanelReport): BadgeJson {
  const { passes, total } = panelTotals(report);
  if (total === 0) {
    return { schemaVersion: 1, label: BADGE_LABEL, message: "no agents ran", color: "lightgrey" };
  }
  const score = percent(passes, total);
  return { schemaVersion: 1, label: BADGE_LABEL, message: `${score}/100`, color: badgeColor(score) };
}

function badgeColor(score: number): string {
  if (score >= 90) return "brightgreen";
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  if (score >= 10) return "orange";
  return "red";
}

/**
 * Write the report artifacts of a run into `outDir`:
 * ergolab-report.json, report/report.md, and badge.json.
 */
export async function writeReportArtifacts(report: PanelReport, outDir: string): Promise<void> {
  await mkdir(path.join(outDir, REPORT_DIRNAME), { recursive: true });
  await writeFile(path.join(outDir, REPORT_FILENAME), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, REPORT_DIRNAME, MARKDOWN_FILENAME), renderMarkdown(report));
  await writeFile(path.join(outDir, BADGE_FILENAME), `${JSON.stringify(renderBadge(report), null, 2)}\n`);
}
