// Parses WhatsApp Cloud API webhook payloads into StoredMessage records and
// verifies Meta's X-Hub-Signature-256 header.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store, StoredMessage } from "./store";

export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;

/** Converts one Cloud API message object (inbound or echo) into our record. */
export function toStored(raw: any, waId: string, direction: "in" | "out", source?: StoredMessage["source"]): StoredMessage {
  const m: StoredMessage = {
    id: raw.id,
    waId,
    direction,
    type: raw.type ?? "unknown",
    timestamp: Number(raw.timestamp) || Math.floor(Date.now() / 1000),
    ...(source ? { source } : {}),
    ...(direction === "out" ? { status: "sent" } : {}),
  };
  if (raw.context?.id) m.replyTo = raw.context.id;
  switch (raw.type) {
    case "text":
      m.text = raw.text?.body;
      break;
    case "reaction":
      m.reaction = { messageId: raw.reaction?.message_id, emoji: raw.reaction?.emoji ?? "" };
      m.text = raw.reaction?.emoji ? `reacted ${raw.reaction.emoji}` : "removed a reaction";
      break;
    case "location": {
      const l = raw.location ?? {};
      m.text = [l.name, l.address, `${l.latitude},${l.longitude}`].filter(Boolean).join(" — ");
      break;
    }
    case "contacts":
      m.text = (raw.contacts ?? []).map((c: any) => `${c.name?.formatted_name ?? ""} ${(c.phones ?? []).map((p: any) => p.phone).join(", ")}`.trim()).join("; ");
      break;
    case "button":
      m.text = raw.button?.text;
      break;
    case "interactive": {
      const i = raw.interactive ?? {};
      const r = i.button_reply ?? i.list_reply ?? i.nfm_reply;
      m.text = r?.title ?? r?.body ?? JSON.stringify(i);
      break;
    }
    case "template":
      m.text = `[template ${raw.template?.name ?? ""}]`;
      break;
    case "unsupported":
      m.text = "[message type not supported by the Cloud API]";
      break;
  }
  for (const t of MEDIA_TYPES) {
    if (raw.type === t && raw[t]) {
      m.mediaId = raw[t].id;
      m.mime = raw[t].mime_type;
      if (raw[t].caption) m.caption = raw[t].caption;
      if (raw[t].filename) m.filename = raw[t].filename;
    }
  }
  return m;
}

export type IngestStats = { messages: number; statuses: number; echoes: number; /** inbound messages we had never seen, for flows */ fresh: StoredMessage[] };

/** Applies a full webhook body to the store. Unknown fields are ignored. */
export async function ingest(body: any, store: Store, phoneNumberId?: string): Promise<IngestStats> {
  const stats: IngestStats = { messages: 0, statuses: 0, echoes: 0, fresh: [] };
  if (body?.object !== "whatsapp_business_account") return stats;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      // Ignore events for other numbers on the same WABA.
      if (phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== phoneNumberId) continue;

      if (change.field === "messages") {
        for (const c of v.contacts ?? []) await store.setName(c.wa_id, c.profile?.name ?? "");
        for (const raw of v.messages ?? []) {
          const m = toStored(raw, raw.from, "in", "api");
          const isNew = !(await store.getMessage(m.id));
          await store.saveMessage(m);
          if (isNew) stats.fresh.push(m);
          stats.messages++;
        }
        for (const s of v.statuses ?? []) {
          const err = s.errors?.[0];
          await store.updateStatus(s.id, s.status, err ? `${err.code}: ${err.title ?? err.message ?? ""}`.trim() : undefined);
          stats.statuses++;
        }
      }

      // Coexistence: messages you send from the WhatsApp Business app on your phone.
      if (change.field === "smb_message_echoes") {
        for (const raw of v.message_echoes ?? []) {
          await store.saveMessage(toStored(raw, raw.to, "out", "business_app"));
          stats.echoes++;
        }
      }
    }
  }
  return stats;
}
