// Parses WhatsApp Cloud API webhook payloads into StoredMessage records and
// verifies Meta's X-Hub-Signature-256 header.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Graph } from "./graph";
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

/** Whole-message replies that opt a customer out of marketing. Compared after foldText, so spelling variants match. */
const OPT_OUT_WORDS = ["إيقاف", "ايقاف", "توقف", "إلغاء", "الغاء", "STOP", "UNSUBSCRIBE"];

/** Lowercases, drops Arabic diacritics and tatweel, unifies alef forms and strips punctuation and emoji. */
function foldText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OPT_OUT_SET = new Set(OPT_OUT_WORDS.map(foldText));

// Meta's delivery error when a customer chose "stop receiving marketing messages" in WhatsApp itself.
const META_MARKETING_STOP = 131050;

/**
 * Whether an inbound message is a request to stop marketing: the entire text
 * (or button title) must be one of the opt-out words, so "don't stop sending
 * offers" does not count.
 */
export function optOutVia(m: Pick<StoredMessage, "direction" | "type" | "text">): "keyword" | "button" | null {
  if (m.direction !== "in" || !m.text) return null;
  if (m.type !== "text" && m.type !== "button" && m.type !== "interactive") return null;
  if (!OPT_OUT_SET.has(foldText(m.text))) return null;
  return m.type === "text" ? "keyword" : "button";
}

export type OptOutEvent = {
  waId: string;
  /** "message": the customer wrote or tapped stop, so a confirmation reply is possible. "meta": delivery failed with 131050, nothing can be sent. */
  via: "message" | "meta";
  /** The customer's stop message, so automated flows can skip it. Only for via "message". */
  messageId?: string;
  /** They were already opted out before this event; no confirmation is needed. */
  repeat: boolean;
};

export const OPT_OUT_CONFIRMATION = "تم إيقاف الرسائل الترويجية عنك، ولن يصلك منا أي عروض بعد الآن. للاشتراك من جديد راسلنا.";

/**
 * Tells customers who just opted out that it worked. This is a free-form reply
 * inside the 24-hour window their own message opened. A failure is logged and
 * never thrown, so one bad send cannot block the others or the webhook.
 */
export async function confirmOptOuts(events: readonly OptOutEvent[], graph: Pick<Graph, "sendMessage">, store: Pick<Store, "saveMessage">) {
  for (const e of events) {
    if (e.via !== "message" || e.repeat) continue;
    try {
      const res = await graph.sendMessage(e.waId, { type: "text", text: { body: OPT_OUT_CONFIRMATION } });
      if (res.messageId) {
        await store.saveMessage({
          id: res.messageId,
          waId: res.waId ?? e.waId,
          direction: "out",
          type: "text",
          text: OPT_OUT_CONFIRMATION,
          timestamp: Math.floor(Date.now() / 1000),
          status: "sent",
          source: "api",
        });
      }
    } catch (err) {
      console.error("opt-out confirmation failed", err);
    }
  }
}

export type IngestStats = {
  messages: number;
  statuses: number;
  echoes: number;
  /** inbound messages we had never seen, for flows */
  fresh: StoredMessage[];
  /** customers newly marked as opted out by this webhook */
  optOuts: OptOutEvent[];
};

const isPhone = (s: unknown): s is string => typeof s === "string" && /^\d{7,15}$/.test(s);

/** Applies a full webhook body to the store. Unknown fields are ignored. */
export async function ingest(body: any, store: Store, phoneNumberId?: string): Promise<IngestStats> {
  const stats: IngestStats = { messages: 0, statuses: 0, echoes: 0, fresh: [], optOuts: [] };
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
          // Record the opt-out before saving the message: if saving fails Meta redelivers, and isNew is still true then.
          const via = isNew && isPhone(m.waId) ? optOutVia(m) : null;
          const repeat = via ? (await store.optedOut([m.waId])).has(m.waId) : false;
          if (via) await store.recordOptOut(m.waId, `replied stop (${via})`, m.timestamp * 1000);
          await store.saveMessage(m);
          if (isNew) stats.fresh.push(m);
          if (via) stats.optOuts.push({ waId: m.waId, via: "message", messageId: m.id, repeat });
          stats.messages++;
        }
        for (const s of v.statuses ?? []) {
          const err = s.errors?.[0];
          await store.updateStatus(s.id, s.status, err ? `${err.code}: ${err.title ?? err.message ?? ""}`.trim() : undefined);
          if (Number(err?.code) === META_MARKETING_STOP && isPhone(s.recipient_id)) {
            const repeat = (await store.optedOut([s.recipient_id])).has(s.recipient_id);
            await store.recordOptOut(s.recipient_id, "meta: customer stopped marketing messages (131050)", Number(s.timestamp) * 1000 || Date.now());
            stats.optOuts.push({ waId: s.recipient_id, via: "meta", repeat });
          }
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
