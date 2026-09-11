[English](./README.md) | **简体中文**

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icons/flask-dark.svg">
    <img src="assets/icons/flask.svg" width="42" alt="" valign="middle">
  </picture>
  ErgoLab
</h1>

<p align="center"><strong>一个为编码智能体（coding agents）打造的工具可用性实验室。</strong></p>

<p align="center">
  <a href="https://www.agentconnect.md/blog/grep-beat-lsp-harness/">一项公开实验</a>发现：在定位类任务上，编码智能体选择更丰富的语义工具而非 <code>grep</code> 的比例只有 <strong>0–6%</strong>。
  而在此之前，你没有任何办法在<strong>自己的工具</strong>上量化这件事。
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&pause=1200&width=680&lines=%E6%8A%8A%E4%B8%80%E6%94%AF%E6%99%BA%E8%83%BD%E4%BD%93%E9%9D%A2%E6%9D%BF%E6%8C%87%E5%90%91%E4%BD%A0%E7%9A%84%E5%B7%A5%E5%85%B7;%E6%B5%8B%E9%87%8F%E5%AE%83%E4%BB%AC%E5%9C%A8%E5%93%AA%E9%87%8C%E5%A4%B1%E8%B4%A5%E3%80%81%E8%80%97%E6%97%B6%E5%A4%9A%E4%B9%85%E3%80%81%E6%88%90%E6%9C%AC%E5%A4%9A%E5%B0%91;Claude+Code+%C2%B7+Codex+%C2%B7+Gemini+CLI+%C2%B7+mock+%E5%9F%BA%E7%BA%BF;%E9%80%80%E5%87%BA%E7%A0%81%E9%AA%8C%E8%AF%81%EF%BC%8C%E4%B8%8D%E7%94%A8+LLM+%E8%A3%81%E5%88%A4" alt="ErgoLab — 把一支智能体面板指向你的工具；测量它们在哪里失败、耗时多久、成本多少">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ergolab"><img src="https://img.shields.io/npm/v/ergolab" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="许可证 MIT"></a>
  <a href="https://github.com/SuperMarioYL/ergolab/actions/workflows/ci.yml"><img src="https://github.com/SuperMarioYL/ergolab/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-339933" alt="node >= 22.6">
</p>

---

## 快速开始

一条命令，无需安装。要求 Node.js 22.6+（内置演示服务器用到了 Node 原生 TypeScript 剥离）。

```bash
npx ergolab run demo-mcp
```

ErgoLab 会为每个「智能体 × 任务」组合创建一个全新的沙箱，驱动一个面板 —— 你机器上已安装的所有智能体 CLI（Claude Code、Codex、Gemini CLI；解析顺序是先探测 PATH，再探测已知安装位置，比如 ChatGPT.app 内置的 Codex），外加一个免密钥、确定性的 mock 基线智能体。无法运行的智能体会以 `skipped (原因)` 的形式保留自己的行，而不是被悄悄丢掉。跑完后面板直接打印在终端，工件落盘：

```text
┌──────────┬─────────────────────┬──────────────┬───────────────────┬──────────────────┬─────────────────┬────────────────┐
│ agent    │ find-latest-version │ find-license │ list-dependencies │ count-by-keyword │ find-deprecated │ find-publisher │
├──────────┼─────────────────────┼──────────────┼───────────────────┼──────────────────┼─────────────────┼────────────────┤
│ mock     │ fail 8ms            │ fail 6ms     │ fail 7ms          │ fail 6ms         │ fail 7ms        │ fail 5ms       │
└──────────┴─────────────────────┴──────────────┴───────────────────┴──────────────────┴─────────────────┴────────────────┘
Scorecard: mock 0/6 — panel 0/6 (0%)
```

即使一个智能体 CLI 都没装，你也能拿到完整报告（mock 始终参与）。想在你**自己的工具**上试试：

```bash
cd your-repo
npx ergolab init          # 生成 ergolab.yaml —— 三个开箱即跑的入门任务
# 把三个 prompt 改成你工具的真实操作（唯一超过 60 秒的一步）
npx ergolab run .         # 针对你自己工具的面板报告
```

报告可以直接提交进仓库，也可以把 `badge.json` 放进仓库作为 README 徽章 —— 报告永远留在你自己的仓库里，没有中心化注册表。

## 演示

录制自 `node dist/cli.js run suites/showcase-grep-vs-tool --agents mock,gemini-cli`（内置 A/B 对照中的 grep 一侧；录制机器上没有安装 `gemini-cli`，所以它的行被保留为 skipped）：

<p align="center">
  <img src="assets/ergolab-demo.gif" alt="ErgoLab 运行 showcase 套件：二进制探测（一个智能体被跳过）、六个任务逐个填入面板表格、失败明细表、记分卡、以及最终写出的工件" width="880">
</p>

内置的 showcase 是围绕同样六个任务、同一份数据集的 A/B 对照：

| 套件 | 答案放在哪里 | mock 智能体（只会 grep） |
| --- | --- | --- |
| `showcase-grep-vs-tool` | 沙箱里的一个纯文本文件 | **2/6** —— 两个子串查找通过，精确提取与聚合全部失败 |
| `demo-mcp` | 内置 stdio MCP registry 服务器背后 | **0/6** —— 沙箱里无可 grep 的内容，又没有工具可用 |

这个差距就是产品本身的缩影：一个智能体**用不了**的工具，在报告里就是一整面失败之墙，而且你能看到具体是哪个格子、在哪个阶段断掉的。装了真实智能体 CLI 的机器上它们会自动加入面板 —— 在录制机器上，探测分别在 `~/.local/bin/claude` 找到了 `claude`，在 `/Applications/ChatGPT.app/Contents/Resources/codex` 找到了 `codex`（一个从未进过 PATH 的安装）。完整的录制数字、命令与限制见 [`docs/demo-results.json`](./docs/demo-results.json)。动图可用 `vhs docs/demo.tape` 重新渲染。

## 为什么需要它

你发布了 MCP 服务器、面向智能体的 CLI，或者为智能体写的文档。而你能用的唯一验证手段，是「在自己的 Claude Code 会话里试一下」—— 一个智能体、一天的数据、没有基线、没有成本列，也没法让 Claude Code、Codex、Gemini CLI 在同一组任务上横向对比。

这不是假设出来的问题。2026 年 8 月，一位工具平台作者[亲手搭了正是这套测量](https://www.agentconnect.md/blog/grep-beat-lsp-harness/)，发现在定位类任务上智能体选择更丰富语义工具而非 `grep` 的比例只有 0–6% —— 这个发现在 Hacker News 上引发了大量讨论（97 分，69 条评论）。围观者的反应是「智能体为什么爱用 grep」；而对工具作者来说，可执行的问题是「智能体**到底能不能用我的**接口？具体断在哪里？」

ErgoLab 搬来了经典的可用性实验（usability lab）流程：招募一组被试（这里是编码智能体）、给标准任务、报告他们在哪里失败、耗时多久、成本多少。HCI 几十年前就为人类解决了这件事；现在智能体得到同等待遇：

- **可复现** —— 测试套件就是一个文件（`ergolab.yaml`），验证只看退出码（不用 LLM 裁判，没有裁判漂移），每次运行都是全新沙箱。
- **跨智能体** —— 同一组任务依次跑过 Claude Code、Codex、Gemini CLI 和免密钥的 mock 基线，每对组合一个样本。
- **可行动** —— 失败明细表写明智能体、任务和阶段（setup / agent / verify）；报告是一张可以跨版本 diff 的矩阵。

## 架构

一个进程、一个 `ergolab` 二进制；智能体 CLI 都是子进程。没有服务、没有数据库、也没有沙箱虚拟机 —— 智能体在全新的临时工作目录里、带着你本机的 CLI 登录态运行，也就是你为之构建的那个真实环境。

```text
ergolab.yaml ──► SuiteLoader (yaml + zod)
                     │
                     ▼
                 Runner ──► sandbox/<agent>/<task>/   (每个组合一个全新临时目录)
                              1. setup 脚本
                              2. 智能体子进程（由 driver 构造调用）
                              3. verify 脚本（退出码决定通过与否）
                     │
                     ▼
     Drivers: claude-code · codex · gemini-cli · mock
     (解析 CLI：先 PATH，再回退位置 · 按 driver 注册 mcp_servers · 解析 token 用量)
                     │
                     ▼
                Reporter ──► 终端表格 · report.md · ergolab-report.json · badge.json
```

Driver 接口是唯一的扩展点：`detect()`、`buildInvocation(task, sandbox)`、`parseUsage(rawOutput)`。`detect()` 从不只看 PATH —— 在 macOS 上，只随 ChatGPT.app 安装的 Codex 一样能跑起来；而完全找不到二进制的智能体会被标成 `skipped (reason: not-found)` 或 `skipped (reason: off-path-at <path>)`，绝不会被悄悄丢掉。

## 安装

```bash
# 免安装
npx ergolab run demo-mcp

# 或全局安装
npm install -g ergolab
```

环境要求：Node.js 22.6+（LTS），macOS 或 Linux。要跑真实智能体，还需要对应 CLI 已安装并登录 —— `claude`（Claude Code）、`codex` 或 `gemini`（Gemini CLI）。都不是必需的：mock 智能体永远能产出报告。

从源码构建：

```bash
git clone https://github.com/SuperMarioYL/ergolab.git
cd ergolab
npm install
npm run build
./dist/cli.js run demo-mcp --agents mock
```

## 用法

### 命令

```text
ergolab init                    在当前目录生成 ergolab.yaml（三个开箱即跑的入门任务）
ergolab run <suite>             对一个智能体面板运行测试套件
  --agents <a,b>                面板选择；默认：mock,claude-code,codex,gemini-cli
  --out <dir>                   工件输出目录（默认：当前目录）
ergolab list-suites             列出内置套件以及当前目录下能找到的套件
ergolab showcase                运行内置的 grep-vs-tool 对照套件
ergolab report [file]           重新渲染一份已保存的 ergolab-report.json
  --out <dir>                   重写 report/report.md 与 badge.json 的目录
```

`<suite>` 可以是包含 `ergolab.yaml` 的目录、该文件的路径，或内置套件名（`demo-mcp`、`showcase-grep-vs-tool`）。

### 套件格式

```yaml
tool: leftpad                       # 被测工具 —— 你的库、CLI 或文档

mcp_servers:                        # 可选：为每个智能体注册的 stdio 服务器
  registry:                         # 路径相对套件目录解析
    command: node
    args: ["--experimental-strip-types", "server/index.ts"]

tasks:
  - name: find-latest-version       # 唯一；结果按它索引
    prompt: >-                      # 任务描述，原样交给智能体
      Find the latest stable version of `leftpad` with the registry MCP
      server; write it to answer.txt.
    setup: "echo seed-data > data.txt"   # 可选 shell，智能体运行前执行
    verify: "grep -q '1.4.2' answer.txt" # 退出码 0 = 通过 —— 唯一的判定标准
    timeout_s: 120                  # 可选，默认 120
```

### Driver

| driver | 实际运行 | token 采集 | MCP 注册 |
| --- | --- | --- | --- |
| `claude-code` | 在沙箱中执行 `claude -p <prompt> --output-format json`，非交互运行绕过权限确认 | 结果 `usage` 里的输入、输出与缓存字段 | `--mcp-config` 文件，`~/.claude.json` 的结构 |
| `codex` | `codex exec --json`，`workspace-write`，工作根目录固定为沙箱 | JSONL 流中的 usage 事件 | `-c mcp_servers.<name>=…` 配置覆盖 |
| `gemini-cli` | `gemini -y --output-format json -p <prompt>` | 尽力而为（该 CLI 的输出结构尚未对着真实二进制验证过） | `--mcp-config` 文件，`~/.gemini/settings.json` 的结构 |
| `mock` | 无模型、无密钥、无网络 —— 一个只会 grep 的替身智能体 | 确定性的 prompt 长度估算 | 不注册（设计如此：它扮演的就是缺这个能力的智能体） |

mock driver 刻画的是「grep 优先」的智能体：它从 prompt 里找到要写的输出文件，在沙箱里 grep prompt 提到的实体，复制第一行命中 —— grep 不到就什么都不写。答案可 grep 的任务通过；答案藏在工具后面的任务失败。这份确定性，就是读每个真实智能体时对照的基线。

## 能力

- **面板报告** —— 每个智能体一行，每个任务一格：`pass` / `fail` / `timeout` / `error`，结束时所处阶段（`setup` / `agent` / `verify`）、耗时，以及 CLI 上报的 token 成本。
- **跳过但绝不消失** —— 二进制无法运行的智能体带着原因保留自己的行，面板覆盖度始终可见。
- **退出码验证** —— 确定且免费；没有 LLM 裁判、没有模糊匹配、没有裁判漂移。
- **A/B 双套件模式** —— 同一组任务分别在有/没有你的 MCP 服务器注册（有/没有数据的纯文本镜像）时各跑一遍，测出工具访问到底改变了什么。内置的 `demo-mcp` / `showcase-grep-vs-tool` 就是这对样例。
- **自托管徽章** —— `badge.json` 是一份 [shields.io endpoint](https://shields.io/endpoint) 文档；放在任何能裸访问的地方（如你的仓库），把徽章指过去即可：

  ```text
  https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/<你>/<仓库>/main/badge.json
  ```

  在录制的 showcase 运行上它显示为 `agent-usability 33/100`（橙色）。

**一次运行的诚实边界：** 顺序执行、每对「智能体 × 任务」一个样本 —— 报告呈现的是断崖（2/6、0/6），不是细微差异。重复运行与方差报告在路线图里，不在当前版本。

## 配置

| 字段 | 含义 | 默认值 |
| --- | --- | --- |
| `tool` | 被测工具；报告上下文的名称 | 必填 |
| `mcp_servers.<name>.command` | MCP 服务器的 stdio 命令；套件相对路径按智能体逐一绝对化 | 可选 |
| `mcp_servers.<name>.args` | 参数列表（同样的路径解析） | `[]` |
| `tasks[].name` | 唯一任务 id，结果按它索引 | 必填 |
| `tasks[].prompt` | 任务描述，原样交给智能体 | 必填 |
| `tasks[].setup` | 智能体运行前在沙箱里执行的 shell | 可选 |
| `tasks[].verify` | 退出码决定通过与否的 shell | 必填 |
| `tasks[].timeout_s` | 单任务超时，作用于每个阶段 | `120` |

工件写入 `--out`（默认当前目录）：`ergolab-report.json`、`report/report.md`、`badge.json`，以及 `sandbox/<agent>/<task>-*/` 工作目录（保留用于排查；建议把 `sandbox/` 加进 `.gitignore`）。智能体继承你本机的 CLI 登录态与环境 —— v0.1 有意运行在你为之构建的环境里，而不是容器里。

## 路线图

v0.1 刻意收窄。以下皆不在其中，按大致先后排列：

- 统计学重复、方差报告与并行面板运行
- Docker/VM 沙箱，实现封闭执行
- Windows 支持（先做 macOS 与 Linux）
- 基于会话记录的工具选择探测（当前：A/B 双套件模式）
- 预打包的 GitHub Action（当前：在你自己的 CI 里调用 CLI）

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
