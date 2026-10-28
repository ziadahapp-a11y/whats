import { admin, err } from "@/lib/admin";
import { target, targets } from "@/lib/inbox";
import { getTags } from "@/lib/flows/engine";
import { listDrafts } from "@/lib/flows/storage";
import { lastSync } from "@/lib/wa/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Reading: ?account=main&view=chats|messages (&q= &limit= &chat= &before=)
export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const p = new URL(req.url).searchParams;
  const t = await target(a, p.get("account"));
  if (!t) return err("Unknown number.", 404);
  try {
    if (p.get("view") === "messages") {
      const chat = p.get("chat") ?? "";
      if (!chat) return err("chat is required", 400);
      const before = p.get("before");
      const messages = await t.store.messages(chat, Math.min(Number(p.get("limit")) || 60, 200), before ? Number(before) : undefined);
      const w = await t.store.window(chat);
      return Response.json({ chat, name: await t.store.getName(chat), tags: await getTags(t.state, chat), window: t.kind === "official" ? w : undefined, messages });
    }
    const chats = await t.store.conversations(Math.min(Number(p.get("limit")) || 60, 200), p.get("q") || undefined);
    const drafts = new Map<string, number>();
    for (const d of await listDrafts(t.state, "pending")) drafts.set(d.chat, (drafts.get(d.chat) ?? 0) + 1);
    return Response.json({
      account: t.id,
      kind: t.kind,
      accounts: await targets(a),
      backfill: (await t.backfillStatus?.()) ?? null,
      lastSync: t.kind === "personal" ? await lastSync(t.state) : null,
      chats: await Promise.all(
        // A chat saved before customer ids were read from from_user_id may have no id at all: skip it.
        chats.filter((c) => c.waId && c.waId !== "undefined" && c.waId !== "null").map(async (c) => ({
          waId: c.waId,
          name: c.name,
          lastAt: c.lastAt,
          last: c.last && { text: c.last.text ?? c.last.caption ?? `[${c.last.type}]`, direction: c.last.direction, type: c.last.type },
          group: c.waId.endsWith("@g.us"),
          windowOpen: t.kind === "official" ? c.windowOpen : undefined,
          tags: await getTags(t.state, c.waId),
          drafts: drafts.get(c.waId) ?? 0,
        })),
      ),
    });
  } catch (e) {
    return err(e);
  }
}

// Acting: { op: "send" | "media" | "react" | "read" | "sync" | "tag", account, ... }
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  const t = await target(a, b.account);
  if (!t) return err("Unknown number.", 404);
  try {
    switch (b.op) {
      case "send": {
        const text = String(b.text ?? "").trim();
        if (!text) return err("text is required", 400);
        const chat = t.resolve(String(b.to ?? b.chat ?? ""));
        return Response.json({ sent: true, id: await t.send(chat, text.slice(0, 4096), b.replyTo || undefined) });
      }
      case "media": {
        if (!t.sendMedia) return err("إرفاق الملفات متاح للرقم الرسمي فقط.", 400);
        const f = b.file ?? {};
        const chat = t.resolve(String(b.to ?? b.chat ?? ""));
        const file = { url: String(f.url ?? ""), mime: String(f.mime ?? ""), name: String(f.name ?? "file").slice(0, 200), size: Number(f.size) || 0, caption: String(b.text ?? "").slice(0, 1024) };
        return Response.json({ sent: true, id: await t.sendMedia(chat, file, b.replyTo || undefined) });
      }
      case "react":
        await t.react(t.resolve(String(b.chat ?? "")), String(b.messageId ?? ""), String(b.emoji ?? ""));
        return Response.json({ ok: true });
      case "read":
        return Response.json({ marked: await t.read(String(b.chat ?? "")) });
      case "sync":
        return Response.json({ synced: true, ...(await t.sync()) });
      case "backfill":
        if (!t.backfill) return err("الرقم الرسمي لا يدعم جلب التاريخ القديم: Meta ترسل الرسائل لحظيًا فقط.", 400);
        return Response.json(await t.backfill(!!b.reset));
      case "tag": {
        const chat = String(b.chat ?? "");
        const tag = String(b.tag ?? "").trim().slice(0, 40);
        if (!chat || !tag) return err("chat and tag are required", 400);
        const tags = await getTags(t.state, chat);
        const next = b.remove ? tags.filter((x) => x !== tag) : [...new Set([...tags, tag])].slice(-20);
        await t.state.set(`flow:tags:${chat}`, JSON.stringify(next));
        return Response.json({ tags: next });
      }
      default:
        return err("unknown op", 400);
    }
  } catch (e) {
    return err(e);
  }
}
