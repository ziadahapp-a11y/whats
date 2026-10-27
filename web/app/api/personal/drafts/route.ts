import { admin, err } from "@/lib/admin";
import { target, targets } from "@/lib/inbox";
import { getDraft, listDrafts, updateDraft } from "@/lib/flows/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Replies that flows prepared and are waiting for you: ?account= (all numbers by default) &status=pending
export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const p = new URL(req.url).searchParams;
  const status = (p.get("status") ?? "pending") as "pending" | "sent" | "rejected" | "failed";
  const only = p.get("account");
  const out = [];
  for (const row of await targets(a)) {
    if (only && row.id !== only) continue;
    const t = await target(a, row.id);
    if (!t) continue;
    for (const d of await listDrafts(t.state, status)) out.push({ ...d, accountLabel: row.label });
  }
  return Response.json({ drafts: out.sort((x, y) => y.createdAt - x.createdAt) });
}

// { account, id, action: "approve" | "reject", text? }: approving sends it now (optionally edited).
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as { account?: string; id?: string; action?: string; text?: string };
  const t = await target(a, b.account);
  if (!t) return err("Unknown number.", 404);
  const d = await getDraft(t.state, b.id ?? "");
  if (!d || d.status !== "pending") return err("That draft is gone or already handled.", 404);
  if (b.action === "reject") {
    await updateDraft(t.state, { ...d, status: "rejected" });
    return Response.json({ ok: true, status: "rejected" });
  }
  if (b.action !== "approve") return err("unknown action", 400);
  const text = (b.text ?? d.text).trim().slice(0, 4096);
  if (!text) return err("text is empty", 400);
  // Claim it first so a double click cannot send twice.
  await updateDraft(t.state, { ...d, status: "sent", text });
  try {
    const id = await t.send(d.chat, text, d.replyTo);
    return Response.json({ ok: true, status: "sent", id });
  } catch (e) {
    await updateDraft(t.state, { ...d, status: "failed", text, error: e instanceof Error ? e.message : String(e) });
    return err(e);
  }
}
