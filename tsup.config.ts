import { defineConfig } from "tsup";

/**
 * Build every existing src entry as an ES module. The bin entry
 * (src/cli.ts -> dist/cli.js, see package.json "bin") is appended to
 * this list once the CLI exists; the banner below gives it the node
 * shebang it needs to stay directly executable. On plain library
 * modules such as schema.js the shebang is a spec-legal first line
 * that node strips on import.
 */
export default defineConfig({
  entry: ["src/schema.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
});
