// The few WhatsApp operations shared by the MCP tools, the inbox and the flows.

import type { WASocket } from "baileys";
import type { Store, StoredMessage } from "../store";

const isGroup = (jid: string) => jid.endsWith("@g.us");

/** The message key WhatsApp needs to react to, read or quote a stored message. */
export function keyFor(jid: string, id: string, m?: StoredMessage | null) {
  return {
    remoteJid: jid,
    id,
    fromMe: m?.direction === "out",
    participant: m?.sender && isGroup(jid) && m.direction === "in" ? `${m.sender}@s.whatsapp.net` : undefined,
  };
}

export async function quotedFor(store: Store, jid: string, id?: string) {
  if (!id) return undefined;
  const q = await store.getMessage(id);
  if (!q) return undefined;
  return { key: keyFor(jid, q.id, q), message: { conversation: q.text ?? q.caption ?? "" } } as any;
}

export async function remember(store: Store, sent: any, chat: string, partial: Partial<StoredMessage>) {
  if (!sent?.key?.id) return;
  await store.saveMessage({
    id: sent.key.id,
    waId: chat,
    direction: "out",
    type: "text",
    timestamp: Math.floor(Date.now() / 1000),
    status: "sent",
    ...partial,
  });
}

/** Sends a text (optionally quoting a message) and records it in the cache. Returns the new message id. */
export async function sendText(sock: WASocket, store: Store, jid: string, text: string, replyTo?: string): Promise<string | undefined> {
  const quoted = await quotedFor(store, jid, replyTo);
  const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  await remember(store, sent, jid, { text, replyTo });
  return sent?.key?.id ?? undefined;
}

export async function sendReaction(sock: WASocket, store: Store, jid: string, messageId: string, emoji: string) {
  const q = await store.getMessage(messageId);
  const sent = await sock.sendMessage(jid, { react: { text: emoji, key: keyFor(jid, messageId, q) } });
  return sent?.key?.id ?? undefined;
}

export async function markRead(sock: WASocket, jid: string, msgs: StoredMessage[]) {
  if (!msgs.length) return 0;
  await sock.readMessages(msgs.map((m) => keyFor(jid, m.id, m)));
  return msgs.length;
}

/** The digits of the linked number, from the socket's own id ("9665…:12@s.whatsapp.net"). */
export function meDigits(sock: WASocket): string | undefined {
  const id = sock.user?.id;
  return id ? id.split("@")[0].split(":")[0] : undefined;
}
