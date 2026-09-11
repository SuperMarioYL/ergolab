/**
 * The bundled demo registry MCP server — the "tool" of the demo-mcp suite.
 *
 * A zero-dependency stdio MCP server. The dataset below is the package
 * registry the suite's six tasks query, and the answers exist nowhere
 * else: an agent passes by using this tool surface, not by grepping the
 * sandbox (suites/showcase-grep-vs-tool is the plain-file mirror of the
 * same dataset — the grep arm of the A/B pair).
 *
 * The protocol is implemented directly: JSON-RPC 2.0 messages, one JSON
 * document per line over stdio, and only the stable MCP core an agent
 * CLI needs — initialize, tools/list, tools/call. Run with Node's
 * built-in TypeScript stripping, exactly as the suite registers it:
 *
 *   node --experimental-strip-types server/index.ts
 *
 * Everything below uses erasable TypeScript only (type annotations and
 * interfaces) so it runs under --experimental-strip-types as-is.
 */
import { createInterface } from "node:readline";

// -- the registry dataset ----------------------------------------------------

interface RegistryEntry {
  readonly name: string;
  readonly latestStable: string;
  readonly license: string;
  readonly publisher: string;
  readonly keywords: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly deprecated: boolean;
}

const REGISTRY: readonly RegistryEntry[] = [
  {
    name: "leftpad",
    latestStable: "1.4.2",
    license: "MIT",
    publisher: "ada",
    keywords: ["text-formatting", "strings"],
    dependencies: {},
    deprecated: false,
  },
  {
    name: "rightpad",
    latestStable: "0.9.3",
    license: "MIT",
    publisher: "ada",
    keywords: ["text-formatting", "strings"],
    dependencies: { leftpad: "^1.4.0" },
    deprecated: false,
  },
  {
    name: "kebab-case",
    latestStable: "3.2.0",
    license: "Apache-2.0",
    publisher: "bo",
    keywords: ["text-formatting", "naming"],
    dependencies: {},
    deprecated: false,
  },
  {
    name: "http-fetch",
    latestStable: "2.1.0",
    license: "MIT",
    publisher: "cy",
    keywords: ["networking", "http"],
    dependencies: {},
    deprecated: false,
  },
  {
    name: "old-camelCase",
    latestStable: "0.3.1",
    license: "MIT",
    publisher: "ada",
    keywords: ["legacy"],
    dependencies: {},
    deprecated: true,
  },
];

// -- the tool surface ---------------------------------------------------------

/** All tool arguments are strings, so the schemas stay this simple. */
interface ToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, { readonly type: "string"; readonly description: string }>>;
  readonly required?: readonly string[];
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/** One registry tool per question class the demo tasks ask. */
const TOOLS: readonly ToolDef[] = [
  {
    name: "get_package",
    description:
      "Get one package's registry metadata: latest stable version, SPDX license id, publisher, keywords, runtime dependencies, and whether it is deprecated. Omit version for the latest stable.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Package name, e.g. leftpad" },
        version: { type: "string", description: "Exact version; only latest stable versions are tracked" },
      },
      required: ["name"],
    },
  },
  {
    name: "search_packages",
    description:
      "Search the registry: packages whose name or keywords contain the query. Returns matching package names with their latest stable versions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against package names and keywords" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_packages",
    description: "List every package in the registry with its latest stable version and deprecated flag.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** What one tool call produced: text for the agent, plus a failure flag. */
interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

function entryLines(entry: RegistryEntry): string[] {
  const dependencies = Object.keys(entry.dependencies);
  return [
    `${entry.name} ${entry.latestStable}`,
    `  license: ${entry.license}`,
    `  publisher: ${entry.publisher}`,
    `  keywords: ${entry.keywords.join(", ")}`,
    `  dependencies: ${dependencies.length === 0 ? "(none)" : dependencies.map((name) => `${name} ${entry.dependencies[name]}`).join(", ")}`,
    `  deprecated: ${entry.deprecated ? "yes" : "no"}`,
  ];
}

function getPackage(args: Readonly<Record<string, string>>): ToolOutcome {
  const name = args.name ?? "";
  const entry = REGISTRY.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return { text: `no package named "${name}" in the registry`, isError: true };
  }
  const version = args.version ?? "";
  if (version !== "" && version !== entry.latestStable) {
    return { text: `only ${entry.name} ${entry.latestStable} is tracked (asked for ${version})`, isError: true };
  }
  return { text: entryLines(entry).join("\n"), isError: false };
}

function searchPackages(args: Readonly<Record<string, string>>): ToolOutcome {
  const query = (args.query ?? "").toLowerCase();
  const matches = REGISTRY.filter(
    (entry) => entry.name.toLowerCase().includes(query) || entry.keywords.some((keyword) => keyword.includes(query)),
  );
  const lines = matches.map((entry) => `  ${entry.name} ${entry.latestStable}`);
  return { text: [`${matches.length} packages match "${args.query ?? ""}":`, ...lines].join("\n"), isError: false };
}

function listPackages(): ToolOutcome {
  const lines = REGISTRY.map((entry) => `  ${entry.name} ${entry.latestStable} (deprecated: ${entry.deprecated ? "yes" : "no"})`);
  return { text: [`${REGISTRY.length} packages:`, ...lines].join("\n"), isError: false };
}

function callTool(name: string, args: Readonly<Record<string, string>>): ToolOutcome {
  switch (name) {
    case "get_package":
      return getPackage(args);
    case "search_packages":
      return searchPackages(args);
    case "list_packages":
      return listPackages();
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}

// -- the JSON-RPC / MCP plumbing ----------------------------------------------

/** The protocol version this server answers with when the client names none. */
const PROTOCOL_VERSION = "2025-06-18";

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

/** A JSON-RPC request or notification as the MCP stdio transport frames it. */
interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: unknown;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The message params as a string-keyed object; anything else is empty. */
function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

/** Validate a tool call's arguments against its schema's required strings. */
function invalidArgs(tool: ToolDef, args: Readonly<Record<string, unknown>>): string | undefined {
  for (const name of tool.inputSchema.required ?? []) {
    const value = args[name];
    if (typeof value !== "string" || value === "") {
      return `${tool.name} requires a string argument: ${name}`;
    }
  }
  return undefined;
}

function handleInitialize(id: unknown, params: Readonly<Record<string, unknown>>): void {
  const requested = params.protocolVersion;
  reply(id, {
    // Echo the client's protocol version when it names one — the server
    // implements the stable core, so the client's version is the one to use.
    protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "demo-registry", version: "0.1.0" },
  });
}

function handleToolsCall(id: unknown, params: Readonly<Record<string, unknown>>): void {
  const toolName = params.name;
  const tool = typeof toolName === "string" ? TOOLS.find((candidate) => candidate.name === toolName) : undefined;
  if (tool === undefined) {
    replyError(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${String(toolName)}`);
    return;
  }
  const args = objectOf(params.arguments);
  const problem = invalidArgs(tool, args);
  if (problem !== undefined) {
    replyError(id, JSON_RPC_INVALID_PARAMS, problem);
    return;
  }
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") strings[key] = value;
  }
  const outcome = callTool(tool.name, strings);
  const result: Record<string, unknown> = { content: [{ type: "text", text: outcome.text }] };
  if (outcome.isError) result.isError = true;
  reply(id, result);
}

function handleMessage(message: JsonRpcMessage): void {
  const method = message.method;
  if (method === undefined) return; // a response to a request we never make
  const { id } = message;
  const isRequest = id !== undefined;
  switch (method) {
    case "initialize":
      if (isRequest) handleInitialize(id, objectOf(message.params));
      return;
    case "notifications/initialized":
      return; // a notification; nothing to answer
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list":
      if (isRequest) reply(id, { tools: TOOLS });
      return;
    case "tools/call":
      if (isRequest) handleToolsCall(id, objectOf(message.params));
      return;
    default:
      // Unknown notifications are ignored; unknown requests get the
      // standard JSON-RPC error so a client can tell misrouting from silence.
      if (isRequest) replyError(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

// -- the stdio loop ------------------------------------------------------------

const lines = createInterface({ input: process.stdin });

lines.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    replyError(null, JSON_RPC_PARSE_ERROR, `parse error: ${trimmed.slice(0, 80)}`);
    return;
  }
  if (typeof message === "object" && message !== null) {
    handleMessage(message as JsonRpcMessage);
  }
});

// The client closed stdin: the session is over.
lines.on("close", () => {
  process.exit(0);
});
