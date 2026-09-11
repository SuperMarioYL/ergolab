/**
 * Tests for src/drivers/detect.ts — the binary-discovery seam every CLI
 * driver shares.
 *
 * Probe order (PATH first, then per-driver fallback locations), the
 * skip-reason format (`not-found` / `off-path-at <path>`), and the
 * per-driver command names are verified here against real temp
 * directories — the same stat probe `which` performs, no subprocess.
 * Fallback locations are read from the live HOME at probe time, so
 * pointing HOME at a temp dir makes the ~/.local/bin fallback hermetic.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCli, resolveDriverCli } from "../src/drivers/detect";

const scratchDirs: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** An executable file named `name` inside a fresh temp dir. */
async function executable(name: string): Promise<{ dir: string; file: string }> {
  const dir = await scratchDir("ergolab-detect-");
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return { dir, file };
}

/** Run `body` with HOME pointed at a fresh temp dir; always restores it. */
async function withTempHome<T>(body: () => Promise<T>): Promise<T> {
  const home = await scratchDir("ergolab-detect-home-");
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await body();
  } finally {
    process.env.HOME = previous;
  }
}

afterEach(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  scratchDirs.length = 0;
});

describe("resolveCli — the probe every driver shares", () => {
  it("finds the binary on PATH first, before any fallback", async () => {
    const fallback = await executable("claude");
    const onPath = await executable("claude");

    const resolution = resolveCli("claude", [fallback.file], onPath.dir);

    expect(resolution).toEqual({ status: "runnable", path: onPath.file });
  });

  it("runs a binary found at a fallback location off PATH", async () => {
    const { file } = await executable("codex");

    const resolution = resolveCli("codex", [file], "/nowhere-on-path");

    expect(resolution).toEqual({ status: "runnable", path: file });
  });

  it("probes fallbacks in order and takes the first runnable one", async () => {
    const first = await executable("gemini");
    const second = await executable("gemini");

    const resolution = resolveCli("gemini", [first.file, second.file], "/nowhere-on-path");

    expect(resolution).toEqual({ status: "runnable", path: first.file });
  });

  it("reports off-path-at for a found-but-unrunnable binary", async () => {
    const dir = await scratchDir("ergolab-detect-fallback-");
    const file = path.join(dir, "codex");
    await writeFile(file, "present but not executable\n");
    await chmod(file, 0o644);

    const resolution = resolveCli("codex", [file], "/nowhere-on-path");

    expect(resolution).toEqual({ status: "skipped", reason: `off-path-at ${file}` });
  });

  it("reports not-found when no probe location has the binary", () => {
    const resolution = resolveCli("gemini", [], "/nowhere-on-path");

    expect(resolution).toEqual({ status: "skipped", reason: "not-found" });
  });

  it("stops at a found-but-unrunnable fallback instead of a later runnable one", async () => {
    const dir = await scratchDir("ergolab-detect-order-");
    const unrunnable = path.join(dir, "codex");
    await writeFile(unrunnable, "present but not executable\n");
    await chmod(unrunnable, 0o644);
    const runnable = await executable("codex");

    const resolution = resolveCli("codex", [unrunnable, runnable.file], "/nowhere-on-path");

    // An install that exists but cannot run is surfaced, not skipped over:
    // the machine has a problem worth seeing.
    expect(resolution).toEqual({ status: "skipped", reason: `off-path-at ${unrunnable}` });
  });

  it("skips empty PATH entries instead of probing the cwd", () => {
    const resolution = resolveCli("claude", [], "nowhere::/also-nowhere");

    expect(resolution).toEqual({ status: "skipped", reason: "not-found" });
  });
});

describe("resolveDriverCli — per-driver probe specs", () => {
  const COMMANDS: Record<string, string> = { "claude-code": "claude", codex: "codex", "gemini-cli": "gemini" };

  it.each(Object.keys(COMMANDS) as ["claude-code", "codex", "gemini-cli"])(
    "%s: probes its own command on PATH",
    async (driver) => {
      const { dir, file } = await executable(COMMANDS[driver]);

      const resolution = resolveDriverCli(driver, dir);

      expect(resolution).toEqual({ status: "runnable", path: file });
    },
  );

  it.each(Object.keys(COMMANDS) as ["claude-code", "codex", "gemini-cli"])(
    "%s: falls back to the ~/.local/bin install when PATH has none",
    async (driver) => {
      await withTempHome(async () => {
        const home = process.env.HOME as string;
        const localBin = path.join(home, ".local", "bin");
        await mkdir(localBin, { recursive: true });
        const file = path.join(localBin, COMMANDS[driver]);
        await writeFile(file, "#!/bin/sh\nexit 0\n");
        await chmod(file, 0o755);

        const resolution = resolveDriverCli(driver, "/nowhere-on-path");

        expect(resolution).toEqual({ status: "runnable", path: file });
      });
    },
  );
});
