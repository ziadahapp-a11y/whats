// One interface over a personal number and the official number, for the dashboard.

import type { Admin } from "./admin";
import { normalizePhone } from "./graph";
import { mediaKind, mediaProblem } from "./media";
import { dropUpload, loadUpload } from "./upload";
import { runtime } from "./runtime";
import type { Store } from "./store";
import { listAccounts, OFFICIAL, scopeRaw } from "./wa/accounts";
import type { RawKV } from "./wa/auth";
import { markRead, sendReaction, sendText } from "./wa/ops";
import { toJid, withWhatsApp } from "./wa/session";
import { syncAccount } from "./flows/sync";
import { backfillStep, readBackfill, resetBackfill, type BackfillProgress } from "./wa/backfill";

export type Target = {
  id: string;
  kind: "personal" | "official";
  label: string;
  store: Store;
  state: RawKV;
  resolve(to: string): string;
  send(chat: string, text: string, replyTo?: string): Promise<string | undefined>;
  /** Official number only: an image or document the inbox uploaded in pieces (lib/upload.ts). */
  sendMedia?(chat: string, uploadId: string, caption?: string, replyTo?: string): Promise<string | undefined>;
  /** Official number only: an approved template, allowed outside the 24-hour window (billed by Meta). */
  sendTemplate?(chat: string, t: TemplateSend): Promise<string | undefined>;
  react(chat: string, messageId: string, emoji: string): Promise<void>;
  read(chat: string): Promise<number>;
  sync(): Promise<{ newMessages: number }>;
  /** Personal numbers only: pulls older history from the phone in resumable slices. */
  backfill?(reset?: boolean): Promise<BackfillProgress>;
  backfillStatus?(): Promise<{ done: number; added: number; finishedAt?: number } | null>;
};

export type TemplateSend = { name: string; language: string; params: string[]; body?: string; headerUpload?: string };

/** The approved templates the inbox can send, with what each one needs filled in. */
export function sendableTemplates(data: any[]) {
  return data
    .filter((t) => t?.status === "APPROVED")
    .map((t) => {
      const comps: any[] = t.components ?? [];
      const body = comps.find((c) => c.type === "BODY")?.text ?? "";
      const header = comps.find((c) => c.type === "HEADER");
      const params = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m: RegExpMatchArray) => m[1])).size;
      return { name: String(t.name), language: String(t.language), category: String(t.category), body, params, header: header?.format === "IMAGE" ? "IMAGE" : header?.format === "TEXT" ? "TEXT" : null, headerText: header?.format === "TEXT" ? header.text : undefined };
    })
    // headers with a variable, video or document are left to the assistant for now
    .filter((t) => t.header !== "TEXT" || !/\{\{/.test(t.headerText ?? ""));
}

export const officialConfigured = (a: Admin) => !!a.cfg.accessToken && !!a.cfg.phoneNumberId;

export async function targets(a: Admin): Promise<{ id: string; label: string; kind: "personal" | "official" }[]> {
  const rows = (await listAccounts(a.base)).map((x) => ({ id: x.id, label: x.label, kind: "personal" as const }));
  return officialConfigured(a) ? [...rows, { id: OFFICIAL, label: "الرقم الرسمي (Cloud API)", kind: "official" as const }] : rows;
}

export async function target(a: Admin, id: string | null | undefined): Promise<Target | null> {
  const want = (id || "main").toLowerCase();
  if (want === OFFICIAL) {
    if (!officialConfigured(a)) return null;
    const { store, graph } = runtime();
    return {
      id: OFFICIAL,
      kind: "official",
      label: "الرقم الرسمي",
      store,
      state: scopeRaw(a.base, "off:"),
      resolve: normalizePhone,
      send: async (chat, text, replyTo) => {
        const w = await store.window(chat);
        if (!w.windowOpen) throw new Error("The 24-hour window is closed for this customer; only an approved template can be sent.");
        const res = await graph.sendMessage(chat, { type: "text", text: { body: text } }, replyTo);
        await store.saveMessage({ id: res.messageId, waId: chat, direction: "out", type: "text", text, timestamp: Math.floor(Date.now() / 1000), status: "sent", source: "api", replyTo });
        return res.messageId;
      },
      sendMedia: async (chat, uploadId, caption, replyTo) => {
        const w = await store.window(chat);
        if (!w.windowOpen) throw new Error("The 24-hour window is closed for this customer; only an approved template can be sent.");
        const f = await loadUpload(a.base, uploadId);
        if (!f) throw new Error("الملف ما وصل كامل أو انتهت صلاحيته، أرفقه مرة ثانية.");
        try {
          const problem = mediaProblem(f.mime, f.size);
          if (problem) throw new Error(problem);
          const type = mediaKind(f.mime)!;
          const mediaId = await graph.uploadMedia(f.bytes, f.mime, f.name);
          const text = caption?.trim() || undefined;
          const media: Record<string, string> = { id: mediaId };
          if (text) media.caption = text;
          if (type === "document") media.filename = f.name;
          const res = await graph.sendMessage(chat, { type, [type]: media }, replyTo);
          await store.saveMessage({ id: res.messageId, waId: chat, direction: "out", type, caption: text, filename: f.name, mime: f.mime, mediaId, timestamp: Math.floor(Date.now() / 1000), status: "sent", source: "api", replyTo });
          return res.messageId;
        } finally {
          await dropUpload(a.base, uploadId);
        }
      },
      sendTemplate: async (chat, t) => {
        const components: Record<string, unknown>[] = [];
        let mediaId: string | undefined;
        if (t.headerUpload) {
          const img = await loadUpload(a.base, t.headerUpload);
          if (!img) throw new Error("صورة الرأس ما وصلت كاملة أو انتهت صلاحيتها، اخترها مرة ثانية.");
          try {
            if (!["image/jpeg", "image/png"].includes(img.mime) || img.size > 5 * 1024 * 1024) throw new Error("صورة الرأس لازم JPG أو PNG وأقل من 5 ميقا.");
            mediaId = await graph.uploadMedia(img.bytes, img.mime, img.name);
          } finally {
            await dropUpload(a.base, t.headerUpload);
          }
          components.push({ type: "header", parameters: [{ type: "image", image: { id: mediaId } }] });
        }
        if (t.params.length) components.push({ type: "body", parameters: t.params.map((text) => ({ type: "text", text })) });
        const res = await graph.sendMessage(chat, { type: "template", template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) } });
        const text = (t.body ?? "").replace(/\{\{(\d+)\}\}/g, (_, n) => t.params[Number(n) - 1] ?? "");
        await store.saveMessage({ id: res.messageId, waId: chat, direction: "out", type: "template", text: text || `[قالب ${t.name}]`, mediaId, timestamp: Math.floor(Date.now() / 1000), status: "sent", source: "api" });
        return res.messageId;
      },
      react: async (chat, messageId, emoji) => void (await graph.sendMessage(chat, { type: "reaction", reaction: { message_id: messageId, emoji } })),
      read: async (chat) => {
        const last = (await store.messages(chat, 50)).filter((m) => m.direction === "in").slice(-1)[0];
        if (last) await graph.markRead(last.id);
        return last ? 1 : 0;
      },
      sync: async () => ({ newMessages: 0 }), // the webhook delivers in real time
    };
  }
  const acc = (await listAccounts(a.base)).find((x) => x.id === want);
  if (!acc) return null;
  const d = a.account(acc.id);
  return {
    id: acc.id,
    kind: "personal",
    label: acc.label,
    store: d.store,
    state: d.raw,
    resolve: toJid,
    send: async (chat, text, replyTo) => (await withWhatsApp(d, (sock) => sendText(sock, d.store, chat, text, replyTo), { drain: false })).result,
    react: async (chat, messageId, emoji) => void (await withWhatsApp(d, (sock) => sendReaction(sock, d.store, chat, messageId, emoji), { drain: false })),
    read: async (chat) => {
      const incoming = (await d.store.messages(chat, 100)).filter((m) => m.direction === "in").slice(-10);
      if (incoming.length) await withWhatsApp(d, (sock) => markRead(sock, chat, incoming), { drain: false });
      return incoming.length;
    },
    sync: async () => ({ newMessages: (await syncAccount(a.base, d, { maxMs: 100_000 })).ingested }),
    backfill: async (reset) => {
      if (reset) await resetBackfill(d.raw);
      return backfillStep(d, { maxMs: 100_000 });
    },
    backfillStatus: async () => {
      const s = await readBackfill(d.raw);
      return s && { done: s.done.length, added: s.added, finishedAt: s.finishedAt };
    },
  };
}
