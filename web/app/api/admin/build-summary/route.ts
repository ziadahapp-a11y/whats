import { authenticate } from "@/lib/access";
import { personal, runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-time build of the official chat-list summary. Needs the master key or a full-scope device key.
export async function POST(req: Request) {
  const { cfg, base } = personal();
  const p = await authenticate(req, cfg, base);
  if (!p || p.scope !== "full") return Response.json({ error: "unauthorized" }, { status: 401 });
  const { store } = runtime();
  const started = Date.now();
  const chats = await store.rebuildSummary();
  return Response.json({ ok: true, chats, ms: Date.now() - started });
}
