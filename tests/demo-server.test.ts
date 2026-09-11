/**
 * Protocol-level tests for the bundled demo registry MCP server.
 *
 * The server runs as a real spawned process — the same
 * `node --experimental-strip-types server/index.ts` invocation the
 * demo-mcp suite registers in mcp_servers — and these tests are a
 * stdio MCP client: initialize handshake, tools/list, tools/call, and
 * the JSON-RPC error paths. No MCP SDK anywhere: the point is that the
 * zero-dependency server speaks the protocol an agent CLI expects.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER = path.join(repoRoot, "suites", "demo-mcp", "server", "index.ts");

/** A parsed JSON-RPC response from the server. */
interface Response {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

/** One MCP session over the server's stdio, as an agent CLI drives it. */
class ServerSession {
  private nextId = 1;
  private readonly pending = new Map<number, (response: Response) => void>();
  private readonly child = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  constructor() {
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line: string) => {
      const message = JSON.parse(line) as Response;
      if (typeof message.id === "number") {
        const resolve = this.pending.get(message.id);
        if (resolve !== undefined) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
    // The server must never write protocol data to stderr; keep the pipe
    // drained so a noisy child cannot deadlock.
    this.child.stderr.resume();
  }

  /** Send a request and resolve with its response, failing on silence. */
  request(method: string, params: unknown = {}): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 5s`)), 5000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const sessions: ServerSession[] = [];

function session(): ServerSession {
  const created = new ServerSession();
  sessions.push(created);
  return created;
}

afterEach(() => {
  for (const open of sessions) open.close();
  sessions.length = 0;
});

/** The text of a tools/call result, failing the test on protocol errors. */
function textOf(response: Response): string {
  expect(response.error).toBeUndefined();
  const result = response.result as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  expect(result.content).toHaveLength(1);
  expect(result.content?.[0]?.type).toBe("text");
  return result.content?.[0]?.text ?? "";
}

/** The text of a tools/call result plus its isError flag. */
function outcomeOf(response: Response): { text: string; isError: boolean } {
  const result = response.result as { isError?: boolean };
  return { text: textOf(response), isError: result.isError === true };
}

describe("demo registry MCP server", () => {
  it("completes the initialize handshake and answers ping", async () => {
    const server = session();

    const init = await server.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0" },
    });

    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26", // the client's version, echoed back
      capabilities: { tools: {} },
      serverInfo: { name: "demo-registry" },
    });

    server.notify("notifications/initialized");
    const pong = await server.request("ping");
    expect(pong.result).toEqual({});
  });

  it("lists its three tools with schemas and required arguments", async () => {
    const server = session();
    await server.request("initialize");

    const listing = await server.request("tools/list");
    expect(listing.error).toBeUndefined();
    const tools = (listing.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["get_package", "search_packages", "list_packages"]);
    expect(tools.find((tool) => tool.name === "get_package")?.inputSchema.required).toEqual(["name"]);
  });

  it("answers the six demo tasks' questions", async () => {
    const server = session();
    await server.request("initialize");

    // find-latest-version
    expect(textOf(await server.request("tools/call", { name: "get_package", arguments: { name: "leftpad" } }))).toContain("leftpad 1.4.2");
    // find-license
    expect(textOf(await server.request("tools/call", { name: "get_package", arguments: { name: "kebab-case" } }))).toContain("license: Apache-2.0");
    // list-dependencies
    expect(textOf(await server.request("tools/call", { name: "get_package", arguments: { name: "rightpad" } }))).toContain("dependencies: leftpad ^1.4.0");
    // count-by-keyword
    expect(textOf(await server.request("tools/call", { name: "search_packages", arguments: { query: "text-formatting" } }))).toContain("3 packages match");
    // find-deprecated
    expect(textOf(await server.request("tools/call", { name: "list_packages" }))).toContain("old-camelCase 0.3.1 (deprecated: yes)");
    // find-publisher
    expect(textOf(await server.request("tools/call", { name: "get_package", arguments: { name: "http-fetch" } }))).toContain("publisher: cy");
  });

  it("flags unknown packages and untracked versions as tool errors, not protocol errors", async () => {
    const server = session();
    await server.request("initialize");

    expect(outcomeOf(await server.request("tools/call", { name: "get_package", arguments: { name: "no-such" } }))).toMatchObject({
      isError: true,
    });
    expect(
      outcomeOf(await server.request("tools/call", { name: "get_package", arguments: { name: "leftpad", version: "0.0.1" } })),
    ).toMatchObject({ isError: true });
  });

  it("answers JSON-RPC errors for unknown methods, unknown tools, and missing arguments", async () => {
    const server = session();
    await server.request("initialize");

    expect(await server.request("resources/list")).toMatchObject({ error: { code: -32601 } });
    expect(await server.request("tools/call", { name: "not-a-tool" })).toMatchObject({ error: { code: -32602 } });
    expect(await server.request("tools/call", { name: "get_package", arguments: {} })).toMatchObject({
      error: { code: -32602, message: expect.stringContaining("name") },
    });
  });

  it("ignores unknown notifications instead of answering them", async () => {
    const server = session();
    await server.request("initialize");

    // The next response must belong to the request that follows the
    // notification, proving the notification itself was not answered.
    server.notify("notifications/whatever");
    const pong = await server.request("ping");
    expect(pong.id).toBe(2);
    expect(pong.result).toEqual({});
  });
});
