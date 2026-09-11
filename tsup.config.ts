import { chmod } from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "tsup";

/**
 * Build every src entry as an ES module. src/cli.ts is the bin entry
 * (dist/cli.js, see package.json "bin"); the banner below gives it the
 * node shebang it needs to stay directly executable. On plain library
 * modules such as schema.js the shebang is a spec-legal first line that
 * node strips on import.
 */
export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/schema.ts",
    "src/suite.ts",
    "src/runner.ts",
    "src/report.ts",
    "src/drivers/types.ts",
    "src/drivers/detect.ts",
    "src/drivers/mock.ts",
    "src/drivers/claude-code.ts",
    "src/drivers/codex.ts",
    "src/drivers/gemini-cli.ts",
  ],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  onSuccess: async () => {
    // npm sets the exec bit on "bin" at install time; make the built
    // file directly executable too, so ./dist/cli.js works out of the box.
    await chmod(path.join("dist", "cli.js"), 0o755);
  },
});
