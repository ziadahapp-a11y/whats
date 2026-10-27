// A small MCP client (Streamable HTTP) so any model can use the owner's connectors,
// not only Claude. Only tools/list and tools/call are needed.

import { assertPublicUrl } from "./net";

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpConn = { tools(): Promise<McpTool[]>; call(name: string, args: Record<string, unknown>): Promise<string> };

const VERSION = "2025-06-18";

async function readRpc(res: Response, id: number): Promise<any> {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (type.includes("text/event-stream")) {
    for (const block of body.split(/\n\n/)) {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m.id === id) return m;
      } catch {}
    }
    throw new Error("the connector answered without a result");
  }
  try {
    const m = JSON.parse(body);
    return Array.isArray(m) ? m.find((x) => x.id === id) : m;
  } catch {
    throw new Error(`the connector answered ${res.status}`);
  }
}

export function connectMcp(server: { name: string; url: string; token?: string }, opts: { fetchImpl?: typeof fetch; check?: (u: string) => Promise<string> } = {}): McpConn {
  const f = opts.fetchImpl ?? fetch;
  let session: string | undefined;
  let ready: Promise<void> | undefined;
  let n = 0;

  async function rpc(method: string, params: unknown, notify = false): Promise<any> {
    const url = await (opts.check ?? assertPublicUrl)(server.url);
    const id = notify ? undefined : ++n;
    const res = await f(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": VERSION,
        ...(session ? { "Mcp-Session-Id": session } : {}),
        ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
    });
    session ??= res.headers.get("mcp-session-id") ?? undefined;
    if (notify) return null;
    if (!res.ok && !(res.headers.get("content-type") ?? "").includes("json")) throw new Error(`${server.name}: HTTP ${res.status}`);
    const m = await readRpc(res, id!);
    if (m?.error) throw new Error(`${server.name}: ${m.error.message ?? "error"}`);
    return m?.result;
  }

  const init = () =>
    (ready ??= (async () => {
      await rpc("initialize", { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: "whats-mcp", version: "1" } });
      await rpc("notifications/initialized", {}, true).catch(() => {});
    })());

  return {
    async tools() {
      await init();
      const out: McpTool[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await rpc("tools/list", cursor ? { cursor } : {});
        out.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async call(name, args) {
      await init();
      const r = await rpc("tools/call", { name, arguments: args });
      const text = (r?.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      return (r?.isError ? "ERROR: " : "") + (text || JSON.stringify(r?.structuredContent ?? {}));
    },
  };
}
