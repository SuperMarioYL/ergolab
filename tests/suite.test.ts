import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SUITE_FILENAME } from "../src/schema";
import { loadSuite, SuiteValidationError } from "../src/suite";

const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const bundledDir = (suite: string): string => path.join(repoRoot, "suites", suite);

const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ergolab-suite-test-"));
  scratchDirs.push(dir);
  return dir;
}

async function writeSuite(yaml: string): Promise<string> {
  const dir = await scratchDir();
  await writeFile(path.join(dir, SUITE_FILENAME), yaml);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

describe("loadSuite: bundled suites", () => {
  it("loads the demo-mcp suite with its MCP server declaration", async () => {
    const loaded = await loadSuite(bundledDir("demo-mcp"));

    expect(loaded.name).toBe("demo-mcp");
    expect(loaded.suite.tool).toBe("demo-registry");
    expect(loaded.suite.mcp_servers).toEqual({
      registry: { command: "node", args: ["--experimental-strip-types", "server/index.ts"] },
    });
    expect(loaded.suite.tasks.map((task) => task.name)).toEqual([
      "find-latest-version",
      "find-license",
      "list-dependencies",
      "count-by-keyword",
      "find-deprecated",
      "find-publisher",
    ]);
  });

  it("loads the showcase suite with no MCP server", async () => {
    const loaded = await loadSuite(bundledDir("showcase-grep-vs-tool"));

    expect(loaded.name).toBe("showcase-grep-vs-tool");
    expect(loaded.suite.tool).toBe("demo-registry");
    expect(loaded.suite.mcp_servers).toBeUndefined();
    expect(loaded.suite.tasks).toHaveLength(6);
  });

  it("keeps the bundled A/B suites aligned task for task", async () => {
    const tool = await loadSuite(bundledDir("demo-mcp"));
    const grep = await loadSuite(bundledDir("showcase-grep-vs-tool"));

    const shape = (loaded: Awaited<ReturnType<typeof loadSuite>>) =>
      loaded.suite.tasks.map((task) => ({ name: task.name, verify: task.verify }));
    expect(shape(grep)).toEqual(shape(tool));
  });
});

describe("loadSuite: valid suites", () => {
  it("round-trips a suite with every task field", async () => {
    const dir = await writeSuite(`
tool: my-tool
mcp_servers:
  search:
    command: node
    args: ["server.js"]
tasks:
  - name: lookup
    prompt: "Find the marker"
    setup: "echo 'marker: ok' > data.txt"
    verify: "grep -q ok data.txt"
    timeout_s: 60
`);

    const loaded = await loadSuite(dir);

    expect(loaded.dir).toBe(path.resolve(dir));
    expect(loaded.name).toBe(path.basename(dir));
    expect(loaded.suite).toEqual({
      tool: "my-tool",
      mcp_servers: { search: { command: "node", args: ["server.js"] } },
      tasks: [
        {
          name: "lookup",
          prompt: "Find the marker",
          setup: "echo 'marker: ok' > data.txt",
          verify: "grep -q ok data.txt",
          timeout_s: 60,
        },
      ],
    });
  });
});

describe("loadSuite: invalid suites", () => {
  it("rejects duplicate task names with per-issue detail", async () => {
    const dir = await writeSuite(`
tool: my-tool
tasks:
  - name: lookup
    prompt: "a"
    verify: "true"
  - name: lookup
    prompt: "b"
    verify: "true"
`);

    const error = await loadSuite(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SuiteValidationError);
    const validation = error as SuiteValidationError;
    expect(validation.issues.join("\n")).toContain("task names must be unique");
    expect(validation.message).toContain(SUITE_FILENAME);
  });

  it("rejects unknown top-level keys", async () => {
    const dir = await writeSuite(`
tool: my-tool
oops: true
tasks:
  - name: lookup
    prompt: "a"
    verify: "true"
`);

    await expect(loadSuite(dir)).rejects.toBeInstanceOf(SuiteValidationError);
  });

  it("rejects a task without a verify script", async () => {
    const dir = await writeSuite(`
tool: my-tool
tasks:
  - name: lookup
    prompt: "a"
`);

    const validation = (await loadSuite(dir).catch((e: unknown) => e)) as SuiteValidationError;
    expect(validation.issues.some((issue) => issue.includes("verify"))).toBe(true);
  });

  it("rejects a suite with no tasks", async () => {
    const dir = await writeSuite("tool: my-tool\ntasks: []\n");

    await expect(loadSuite(dir)).rejects.toBeInstanceOf(SuiteValidationError);
  });

  it("wraps unparseable YAML", async () => {
    const dir = await writeSuite("tool: [unclosed\n");

    const validation = (await loadSuite(dir).catch((e: unknown) => e)) as SuiteValidationError;
    expect(validation.issues[0]).toContain("invalid YAML");
  });

  it("propagates the fs error for a missing suite file", async () => {
    const dir = await scratchDir();

    await expect(loadSuite(dir)).rejects.toThrow(/ENOENT/);
  });
});
