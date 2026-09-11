# Changelog

All notable changes to ErgoLab are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-11

First public cut: a usability lab for tools built for coding agents.

### m1 — task suite and runner

- `ergolab.yaml` task-suite format (`tool`, optional `mcp_servers`, `tasks`
  with `prompt` / `setup` / `verify` / `timeout_s`), validated with zod in
  strict mode; unique task names enforced.
- Panel runner: fresh sandbox per agent-task pair, sequential
  setup → agent → verify lifecycle, exit-code verification only (no LLM
  judge), per-task timeout enforcement.
- `ergolab-report.json` panel report: one row per agent, one result per task
  with status, stage, wall time, and token cost.
- Keyless deterministic mock driver (a grep-only stand-in agent) so a full
  report needs no API key and no installed agent CLI.

### m2 — the agent panel

- Headless CLI drivers: `claude-code` (`claude -p --output-format json`),
  `codex` (`codex exec --json`), `gemini-cli` (`gemini -y --output-format
  json`), each registering the suite's stdio MCP servers through its CLI's
  native mechanism (`--mcp-config` file or `-c` TOML override) and parsing
  token usage from its output.
- Binary discovery probes PATH first, then known install locations per
  driver and OS — on macOS including the Codex binary shipped inside
  ChatGPT.app — and reports any agent that cannot run as skipped
  (`not-found` / `off-path-at <path>`) instead of silently dropping it.
- Bundled zero-dependency stdio MCP registry server for the demo suite,
  implemented directly over newline-delimited JSON-RPC 2.0.

### m3 — report, badge, ship

- Reporter renders the terminal panel table, the failure list (agent, task,
  status, stage), the one-line scorecard, `report/report.md`, and a
  self-hosted shields.io endpoint `badge.json`.
- `ergolab init` scaffolds a suite with three runnable starter tasks;
  `ergolab list-suites`, `ergolab showcase`, and `ergolab report`
  (re-render from a saved report) round out the CLI.
- Bundled grep-vs-tool showcase: the same six tasks as `demo-mcp` against a
  plain-file mirror of the dataset — the A/B pair that measures what tool
  access changes.
- npm-pack `npx ergolab` quickstart verified on a clean directory; demo gif
  (`assets/ergolab-demo.gif`) recorded from a real run and re-renderable via
  `vhs docs/demo.tape`.
