// One interface over a personal number and the official number, for the dashboard.

import type { Admin } from "./admin";
import { normalizePhone } from "./graph";
import { runtime } from "./runtime";
import type { Store } from "./store";
import { listAccounts, OFFICIAL, scopeRaw } from "./wa/accounts";
import type { RawKV } from "./wa/auth";
import { markRead, sendReaction, sendText } from "./wa/ops";
import { toJid, withWhatsApp } from "./wa/session";
import { syncAccount } from "./flows/sync";

export type Target = {
  id: string;
  kind: "personal" | "official";
  label: string;
  store: Store;
  state: RawKV;
  resolve(to: string): string;
  send(chat: string, text: string, replyTo?: string): Promise<string | undefined>;
  react(chat: string, messageId: string, emoji: string): Promise<void>;
  read(chat: string): Promise<number>;
  sync(): Promise<{ newMessages: number }>;
};

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
  };
}
