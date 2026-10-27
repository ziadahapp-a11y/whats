// Shared by the dashboard API routes: master key only, plus helpers to find a number.

import { authenticate } from "./access";
import { personal } from "./runtime";
import { listAccounts, MAIN, OFFICIAL } from "./wa/accounts";

export type Admin = ReturnType<typeof personal>;

/** The master key, or a ready-made error response. */
export async function admin(req: Request): Promise<Admin | Response> {
  const ctx = personal();
  if (!ctx.cfg.mcpSecret || ctx.cfg.mcpSecret.length < 24) return Response.json({ error: "MCP_SECRET is not configured (24+ characters)." }, { status: 503 });
  if (!ctx.cfg.redisUrl && process.env.ALLOW_MEMORY_STORE !== "1") return Response.json({ error: "Connect Upstash Redis first (Storage tab in Vercel), then redeploy." }, { status: 503 });
  const p = await authenticate(req, ctx.cfg, ctx.base);
  if (!p || p.kind !== "master") return Response.json({ error: "Wrong or missing MCP_SECRET." }, { status: 401 });
  return ctx;
}

/** A personal number by id (default: the first); Response when it does not exist. */
export async function pickAccount(a: Admin, id: string | null | undefined) {
  const want = (id || MAIN).toLowerCase();
  const all = await listAccounts(a.base);
  const hit = all.find((x) => x.id === want);
  if (!hit) return Response.json({ error: `Unknown number "${want}".` }, { status: 404 });
  return { ...hit, deps: a.account(hit.id) };
}

export const isOfficial = (id: string | null | undefined) => id === OFFICIAL;

export const err = (e: unknown, status = 500) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
