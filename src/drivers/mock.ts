/**
 * The mock driver: a keyless, deterministic stand-in agent.
 *
 * It models the grep-first coding agent — the archetype ErgoLab
 * measures. It has no MCP tool access and runs no model. For each task
 * it:
 *
 *   1. finds the output file the prompt asks for, using the prompt
 *      convention "write/save/put/output ... to <file>"
 *      (default: answer.txt);
 *   2. greps the sandbox for the entity the prompt mentions — the
 *      first backticked or quoted span that is not the output file
 *      itself — and copies the first matching line into the output
 *      file;
 *   3. writes nothing when grep finds nothing: the honest failure mode
 *      of an agent that lacks the affordance a task needs;
 *   4. reports a deterministic token estimate (prompt length / 4) so
 *      the cost column is exercised without an API key.
 *
 * Net effect: tasks whose answers are greppable in the sandbox pass;
 * tasks whose answers live behind a tool fail. That yields a full panel
 * report with no installed agent CLI, no API key, and no network — and
 * a deterministic baseline for the grep-vs-tool comparison.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { AgentDriver, AgentRunInput, AgentRunOutcome } from "../runner";

/** Where the mock agent writes when the prompt names no output file. */
const DEFAULT_OUTPUT_FILE = "answer.txt";

/** Matches "write it to answer.txt", "write them, one per line, to deps.txt", ... */
const OUTPUT_FILE_PATTERN = /(?:write|save|put|output)\b[^.;?!]*?\bto\s+`?([\w-]+(?:[./][\w-]+)*)`?/i;

/** Backticked or quoted spans; entities named in prompts are single words. */
const TERM_PATTERN = /`([^`\s]+)`|'([^'\s]+)'|"([^"\s]+)"/g;

export const mockDriver: AgentDriver = {
  name: "mock",

  async runAgent(input: AgentRunInput): Promise<AgentRunOutcome> {
    const output = outputFor(input.task.prompt);
    const term = grepTermFor(input.task.prompt, output);

    if (term !== undefined) {
      const hit = await firstLineContaining(input.sandbox, term);
      if (hit !== undefined) {
        const target = path.join(input.sandbox, output);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${hit}\n`);
      }
    }

    return { kind: "completed", tokens: Math.ceil(input.task.prompt.length / 4) };
  },
};

function outputFor(prompt: string): string {
  return OUTPUT_FILE_PATTERN.exec(prompt)?.[1] ?? DEFAULT_OUTPUT_FILE;
}

function grepTermFor(prompt: string, output: string): string | undefined {
  for (const match of prompt.matchAll(TERM_PATTERN)) {
    const term = match[1] ?? match[2] ?? match[3];
    if (term !== undefined && term.length >= 2 && term !== output) {
      return term;
    }
  }
  return undefined;
}

/**
 * The first line, in sorted path order, that contains `term` — a
 * deterministic grep. Unreadable files are skipped, as a grep-first
 * agent would.
 */
async function firstLineContaining(root: string, term: string): Promise<string | undefined> {
  for (const file of await listFiles(root)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const hit = text.split("\n").find((line) => line.includes(term));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) files.push(full);
      else if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(root);
  return files.sort();
}
