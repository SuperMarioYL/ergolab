/**
 * Shared binary discovery for the agent CLIs.
 *
 * Every CLI driver resolves its binary the same way, and the outcome is
 * part of the panel report's contract: an agent whose binary cannot run
 * is reported as skipped — `not-found`, or `off-path-at <path>` for a
 * binary that exists at a known location but is not runnable from
 * there — instead of being silently dropped. This module owns the probe
 * so the order (PATH first, then per-driver fallback locations per OS)
 * and the reason format exist exactly once.
 *
 * The fallback locations matter most for Codex on macOS, which ships
 * inside ChatGPT.app at /Applications/ChatGPT.app/Contents/Resources/codex
 * and never touches PATH — a failed `which codex` still finds a real
 * install there.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CliResolution } from "./types";

/** Driver ids that resolve their agent CLI through this module. */
export type CliDriverName = "claude-code" | "codex" | "gemini-cli";

/** A driver's CLI binary: the command name plus where else to look for it. */
interface CliSpec {
  /** The binary name the PATH probe looks for. */
  readonly command: string;
  /** Install locations probed, in order, when PATH has none of them. */
  readonly fallbacks: readonly string[];
}

/** The codex binary macOS ships inside ChatGPT.app — never on PATH. */
const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** Install locations the npm-installed agent CLIs commonly use. */
function npmStyleFallbacks(command: string): string[] {
  return [path.join(homedir(), ".local", "bin", command), `/usr/local/bin/${command}`, `/opt/homebrew/bin/${command}`];
}

/**
 * Probe spec per driver: the binary name plus its known install
 * locations. Built per call so HOME and platform are read at probe
 * time, not import time — the same machine can be probed under a
 * different HOME (tests do exactly that).
 */
function cliSpec(driver: CliDriverName): CliSpec {
  switch (driver) {
    case "claude-code":
      return { command: "claude", fallbacks: npmStyleFallbacks("claude") };
    case "codex":
      return {
        command: "codex",
        fallbacks: [...npmStyleFallbacks("codex"), ...(process.platform === "darwin" ? [CHATGPT_APP_CODEX] : [])],
      };
    case "gemini-cli":
      return { command: "gemini", fallbacks: npmStyleFallbacks("gemini") };
  }
}

/**
 * Resolve a CLI binary: PATH first (the probe `which <command>` performs,
 * without a subprocess), then `fallbacks` in order. A fallback binary that
 * runs is used from where it was found; one that exists but cannot run
 * reports `off-path-at <path>`; nothing anywhere reports `not-found`. The
 * reason strings are report values, kept verbatim in the agent's skipped
 * row.
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

/**
 * Resolve a CLI driver's binary using its probe spec: PATH first, then
 * the driver's known install locations (OS-aware). `pathEnv` defaults to
 * the live PATH; callers that already know the environment inject it.
 */
export function resolveDriverCli(driver: CliDriverName, pathEnv: string = process.env.PATH ?? ""): CliResolution {
  const spec = cliSpec(driver);
  return resolveCli(spec.command, spec.fallbacks, pathEnv);
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
