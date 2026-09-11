import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PanelReportSchema, SuiteSchema, TaskSchema } from "../src/schema";

const validTask = {
  name: "grep-marker",
  prompt: "Find the marker line in data.txt",
  setup: "echo 'marker: ok' > data.txt",
  verify: "grep -q 'marker: ok' data.txt",
};

describe("SuiteSchema", () => {
  it("round-trips a minimal suite", () => {
    const suite = {
      tool: "grep-cli",
      mcp_servers: {
        fs: { command: "npx", args: ["-y", "fs-mcp"] },
      },
      tasks: [validTask],
    };

    expect(SuiteSchema.parse(suite)).toEqual(suite);
  });

  it("rejects duplicate task names", () => {
    const suite = {
      tool: "grep-cli",
      tasks: [validTask, { ...validTask }],
    };

    expect(() => SuiteSchema.parse(suite)).toThrow(z.ZodError);
  });

  it("rejects unknown keys in strict mode", () => {
    const suite = { tool: "grep-cli", tasks: [validTask], oops: true };

    expect(() => SuiteSchema.parse(suite)).toThrow(z.ZodError);
  });

  it("rejects tasks without a verify script", () => {
    expect(() =>
      TaskSchema.parse({ name: "grep-marker", prompt: "Find the marker line" }),
    ).toThrow(z.ZodError);
  });
});

describe("PanelReportSchema", () => {
  it("round-trips a report covering a completed and a skipped agent", () => {
    const report = {
      suite: "showcase-grep-vs-tool",
      generated_at: "2026-09-11T02:18:45.000Z",
      agents: [
        {
          driver: "mock",
          results: [
            {
              task: "grep-marker",
              status: "pass",
              stage: "verify",
              wall_ms: 1200,
              tokens: 42,
            },
          ],
        },
        { driver: "claude-code", skipped: "not-found", results: [] },
      ],
    };

    expect(PanelReportSchema.parse(report)).toEqual(report);
  });

  it("rejects results with an unknown status", () => {
    const report = {
      suite: "showcase-grep-vs-tool",
      generated_at: "2026-09-11T02:18:45.000Z",
      agents: [
        {
          driver: "mock",
          results: [
            {
              task: "grep-marker",
              status: "crashed",
              stage: "verify",
              wall_ms: 1200,
            },
          ],
        },
      ],
    };

    expect(() => PanelReportSchema.parse(report)).toThrow(z.ZodError);
  });
});
