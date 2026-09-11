/**
 * Suite loading: turn a suite directory (ergolab.yaml) into a validated
 * Suite. This is the front door of a run — the runner and the CLI
 * consume LoadedSuite, never raw YAML, so every downstream consumer can
 * trust the zod-validated shape from src/schema.ts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodIssue } from "zod";
import { SUITE_FILENAME, SuiteSchema, type Suite } from "./schema";

/** A suite directory loaded and validated against the schema. */
export interface LoadedSuite {
  /** Absolute path of the suite directory. */
  dir: string;
  /**
   * Suite name: the directory's basename (e.g. "demo-mcp"). Panel
   * reports reference the suite by this name.
   */
  name: string;
  /** The validated suite. */
  suite: Suite;
}

/**
 * Thrown when a suite file exists but is not a valid task suite — either
 * unparseable YAML or a schema violation. `issues` carries one
 * human-readable "path: message" line per problem, so a caller can list
 * everything wrong with the file in one shot.
 */
export class SuiteValidationError extends Error {
  readonly issues: readonly string[];

  constructor(filename: string, issues: readonly string[]) {
    super(`${filename} is not a valid task suite:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "SuiteValidationError";
    this.issues = issues;
  }
}

function formatIssue(issue: ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${where}: ${issue.message}`;
}

/**
 * Load and validate the suite in `dir` (the ergolab.yaml inside it).
 *
 * A missing suite file propagates the underlying fs error — the caller
 * knows which directory it asked for. Only files that exist but fail to
 * parse or validate get the structured error above.
 */
export async function loadSuite(dir: string): Promise<LoadedSuite> {
  const resolved = path.resolve(dir);
  const filename = path.join(resolved, SUITE_FILENAME);

  const text = await readFile(filename, "utf8");

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new SuiteValidationError(filename, [`invalid YAML: ${(error as Error).message}`]);
  }

  const parsed = SuiteSchema.safeParse(document);
  if (!parsed.success) {
    throw new SuiteValidationError(filename, parsed.error.issues.map(formatIssue));
  }

  return { dir: resolved, name: path.basename(resolved), suite: parsed.data };
}
