**English** | [简体中文](./README.zh-CN.md)

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icons/flask-dark.svg">
    <img src="assets/icons/flask.svg" width="42" alt="" valign="middle">
  </picture>
  ErgoLab
</h1>

<p align="center"><strong>A usability lab for tools built for coding agents.</strong></p>

<p align="center">
  <a href="https://www.agentconnect.md/blog/grep-beat-lsp-harness/">One public pilot</a> found coding agents chose a richer semantic tool over <code>grep</code> only <strong>0–6%</strong> of the time.
  Until now you had no way to measure that on <em>your</em> tool.
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&pause=1200&width=680&lines=Point+a+panel+of+coding+agents+at+your+tool;Measure+where+they+fail%2C+how+long+they+take%2C+what+they+cost;Claude+Code+%C2%B7+Codex+%C2%B7+Gemini+CLI+%C2%B7+mock+baseline;Exit-code+verification%2C+no+LLM+judge" alt="ErgoLab — point a panel of coding agents at your tool; measure where they fail, how long they take, what they cost">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ergolab"><img src="https://img.shields.io/npm/v/ergolab" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license MIT"></a>
  <a href="https://github.com/SuperMarioYL/ergolab/actions/workflows/ci.yml"><img src="https://github.com/SuperMarioYL/ergolab/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-339933" alt="node >= 22.6">
</p>

---

## Quickstart

One command, no permanent install. Node.js 22.6+ required (the bundled demo server uses built-in TypeScript stripping).

```bash
npx ergolab run demo-mcp
```

ErgoLab spins a fresh sandbox per agent-task pair and drives a panel — every agent CLI installed on your machine (Claude Code, Codex, Gemini CLI; each resolved by probing PATH first, then known install locations such as the ChatGPT.app-bundled Codex), plus a deterministic keyless mock agent as the baseline. An agent that cannot run keeps its row as `skipped (reason)`. Then it prints the panel and writes the artifacts:

```text
┌──────────┬─────────────────────┬──────────────┬───────────────────┬──────────────────┬─────────────────┬────────────────┐
│ agent    │ find-latest-version │ find-license │ list-dependencies │ count-by-keyword │ find-deprecated │ find-publisher │
├──────────┼─────────────────────┼──────────────┼───────────────────┼──────────────────┼─────────────────┼────────────────┤
│ mock     │ fail 8ms            │ fail 6ms     │ fail 7ms          │ fail 6ms         │ fail 7ms        │ fail 5ms       │
└──────────┴─────────────────────┴──────────────┴───────────────────┴──────────────────┴─────────────────┴────────────────┘
Scorecard: mock 0/6 — panel 0/6 (0%)
```

With no agent CLI installed you still get a full report (the mock always runs). To try it on **your** tool:

```bash
cd your-repo
npx ergolab init          # scaffolds ergolab.yaml — three runnable starter tasks
# edit the three prompts to name your tool's operations (the one step over 60 seconds)
npx ergolab run .         # a panel report on your own tool
```

Commit the report, or host `badge.json` in your repo for a README badge — reports stay in your repo, there is no registry.

## Demo

Recorded from `node dist/cli.js run suites/showcase-grep-vs-tool --agents mock,gemini-cli` (the grep arm of the bundled A/B pair; `gemini-cli` is not installed on the recording machine, so its row is kept as skipped):

<p align="center">
  <img src="assets/ergolab-demo.gif" alt="ErgoLab running the showcase suite: binary discovery with one agent skipped, six tasks filling the panel table, the failure table, the scorecard, and the written artifacts" width="880">
</p>

The bundled showcase is an A/B pair over the same six tasks and the same dataset:

| suite | where the answers live | mock agent (grep-only) |
| --- | --- | --- |
| `showcase-grep-vs-tool` | a plain file in the sandbox | **2/6** — the two substring lookups pass, exact extraction and aggregation fail |
| `demo-mcp` | behind the bundled stdio MCP registry server | **0/6** — nothing greppable, no tool access |

That gap is the product in miniature: a tool an agent *cannot* use reads as a wall of failures, and you see exactly which cell broke and at which stage. Real agent CLIs join the panel automatically when installed — on the recording machine discovery found `claude` at `~/.local/bin/claude` and `codex` at `/Applications/ChatGPT.app/Contents/Resources/codex` (an install that never touches PATH). Full recorded numbers, commands, and limitations: [`docs/demo-results.json`](./docs/demo-results.json). The gif is re-renderable with `vhs docs/demo.tape`.

## Why

You shipped an MCP server, an agent-facing CLI, or docs written for agents. The only instrument you had was *trying it in your own Claude Code session* — one agent, one day, no baseline, no cost column, no way to compare Claude Code against Codex against Gemini CLI on the same tasks.

This is not a hypothetical problem. In August 2026 a tool-platform author [hand-rolled exactly this measurement](https://www.agentconnect.md/blog/grep-beat-lsp-harness/) and found agents picked the richer semantic tool over `grep` only 0–6% of the time on location tasks — a finding that sparked a long Hacker News discussion (97 points, 69 comments). The reaction was "why do agents grep"; the actionable question for tool authors is "can agents use *my* surface, and where exactly do they fail?"

ErgoLab transplants the classic usability-lab protocol: recruit a panel (here: coding agents), give standard tasks, report where they fail, how long they take, and what they cost. HCI solved this for humans decades ago; agents get the same treatment:

- **Reproducible** — the suite is a file (`ergolab.yaml`), verification is exit-code deterministic (no LLM judge, no oracle drift), every run gets fresh sandboxes.
- **Cross-agent** — the same tasks run against Claude Code, Codex, Gemini CLI, and a keyless mock baseline, sequentially, one sample per pair.
- **Actionable** — the failure table names the agent, the task, and the stage (setup / agent / verify); the report is a matrix you can diff across releases.

## Architecture

One process, one `ergolab` binary; agent CLIs are child processes. No services, no database, no sandboxing VMs — agents run in fresh temp workdirs with your normal CLI auth, the environment you ship for.

```text
ergolab.yaml ──► SuiteLoader (yaml + zod)
                     │
                     ▼
                 Runner ──► sandbox/<agent>/<task>/   (fresh temp dir each)
                              1. setup script
                              2. agent subprocess (driver-built invocation)
                              3. verify script (exit code decides pass)
                     │
                     ▼
     Drivers: claude-code · codex · gemini-cli · mock
     (resolve CLI: PATH first, then fallbacks · register mcp_servers per driver · parse token usage)
                     │
                     ▼
                Reporter ──► terminal table · report.md · ergolab-report.json · badge.json
```

The driver interface is the only extension point: `detect()`, `buildInvocation(task, sandbox)`, `parseUsage(rawOutput)`. `detect()` never assumes PATH alone — on macOS, a Codex that ships only inside ChatGPT.app still runs, and a missing binary is reported as `skipped (reason: not-found)` or `skipped (reason: off-path-at <path>)`, never silently dropped.

## Installation

```bash
# no install
npx ergolab run demo-mcp

# or globally
npm install -g ergolab
```

Requirements: Node.js 22.6+ (LTS), macOS or Linux. To run real agents you also need the corresponding CLI installed and authenticated — `claude` (Claude Code), `codex`, or `gemini` (Gemini CLI). None are required: the mock agent always produces a report.

From source:

```bash
git clone https://github.com/SuperMarioYL/ergolab.git
cd ergolab
npm install
npm run build
./dist/cli.js run demo-mcp --agents mock
```

## Usage

### Commands

```text
ergolab init                    scaffold ergolab.yaml (three runnable starter tasks) in the cwd
ergolab run <suite>             run a suite against a panel of agents
  --agents <a,b>                panel selection; default: mock,claude-code,codex,gemini-cli
  --out <dir>                   artifact directory (default: cwd)
ergolab list-suites             bundled suites plus any in the cwd
ergolab showcase                run the bundled grep-vs-tool showcase suite
ergolab report [file]           re-render a saved ergolab-report.json
  --out <dir>                   where to re-write report/report.md and badge.json
```

`<suite>` is a directory containing `ergolab.yaml`, a path to the file itself, or a bundled suite name (`demo-mcp`, `showcase-grep-vs-tool`).

### The suite format

```yaml
tool: leftpad                       # the tool under test — your library, CLI, or docs

mcp_servers:                        # optional: stdio servers registered for every agent
  registry:                         # paths resolve against this suite directory
    command: node
    args: ["--experimental-strip-types", "server/index.ts"]

tasks:
  - name: find-latest-version       # unique; results are keyed by it
    prompt: >-                      # the ask, handed to the agent verbatim
      Find the latest stable version of `leftpad` with the registry MCP
      server; write it to answer.txt.
    setup: "echo seed-data > data.txt"   # optional shell, run before the agent
    verify: "grep -q '1.4.2' answer.txt" # exit 0 = pass — the only oracle
    timeout_s: 120                  # optional, default 120
```

### Drivers

| driver | what runs | token capture | MCP registration |
| --- | --- | --- | --- |
| `claude-code` | `claude -p <prompt> --output-format json` in the sandbox, permissions bypassed for the non-interactive run | input, output, and cache fields from the result's `usage` | `--mcp-config` file, the `~/.claude.json` shape |
| `codex` | `codex exec --json` with `workspace-write`, working root pinned to the sandbox | usage events from the JSONL stream | `-c mcp_servers.<name>=…` config overrides |
| `gemini-cli` | `gemini -y --output-format json -p <prompt>` | best effort (the CLI's output shape is not yet verified against a live binary) | `--mcp-config` file, the `~/.gemini/settings.json` shape |
| `mock` | no model, no key, no network — a grep-only stand-in agent | deterministic prompt-length estimate | none, by design (it models the agent without the affordance) |

The mock driver models the grep-first agent: it finds the output file the prompt names, greps the sandbox for the entity the prompt mentions, and copies the first matching line — writing nothing when grep finds nothing. Tasks whose answers are greppable pass; tasks whose answers live behind a tool fail. That determinism is the baseline every real agent is read against.

## Capabilities

- **The panel report** — one row per agent, one cell per task: `pass` / `fail` / `timeout` / `error`, the stage the run ended in (`setup` / `agent` / `verify`), wall time, and token cost where the CLI reports it.
- **Skipped, never dropped** — an agent whose binary cannot run keeps its row with the reason, so panel coverage stays visible.
- **Exit-code verification** — deterministic and free; no LLM judge, no fuzzy matching, no oracle drift between runs.
- **The A/B two-suite pattern** — run the same tasks with and without your MCP server registered (with and without a plain-file mirror of the data) to measure what tool access changes. See the bundled `demo-mcp` / `showcase-grep-vs-tool` pair.
- **Self-hosted badge** — `badge.json` is a [shields.io endpoint](https://shields.io/endpoint) document; host it anywhere raw (e.g. a gist or your repo) and point a badge at it:

  ```text
  https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<you>/<repo>/main/badge.json
  ```

  On the recorded showcase run it reads `agent-usability 33/100` (orange).

**Honest limits of one run:** sequential, one sample per agent-task pair — the report surfaces cliffs (2 of 6, 0 of 6), not fine differences. Repeats and variance reporting are roadmap items, not shipped behavior.

## Configuration

| field | meaning | default |
| --- | --- | --- |
| `tool` | the tool under test; names the report context | required |
| `mcp_servers.<name>.command` | stdio command for an MCP server; suite-relative paths are absolutized per agent | optional |
| `mcp_servers.<name>.args` | argument list (same path resolution) | `[]` |
| `tasks[].name` | unique task id, keyed in results | required |
| `tasks[].prompt` | the ask, verbatim to the agent | required |
| `tasks[].setup` | shell run in the sandbox before the agent | optional |
| `tasks[].verify` | shell whose exit code decides pass/fail | required |
| `tasks[].timeout_s` | per-task timeout, applied to each stage | `120` |

Artifacts land in `--out` (default: the cwd): `ergolab-report.json`, `report/report.md`, `badge.json`, and `sandbox/<agent>/<task>-*/` workdirs (kept for debugging; add `sandbox/` to your `.gitignore`). Agents inherit your normal CLI auth and environment — v0.1 deliberately runs in the environment you ship for, not a container.

## Roadmap

v0.1 is deliberately narrow. Not in it, in rough order of likely arrival:

- Statistical repeats, variance reporting, and parallel panel runs
- Docker/VM sandboxing for hermetic agent execution
- Windows support (macOS and Linux first)
- Transcript-level tool-choice instrumentation (today: the A/B two-suite pattern)
- Prebuilt GitHub Action packaging (today: call the CLI from your own CI)

## License

MIT — see [LICENSE](./LICENSE).

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
