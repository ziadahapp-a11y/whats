// Connect-on-demand WhatsApp session for serverless functions.
//
// Each call opens the linked-device connection with the session stored in
// Redis, lets WhatsApp deliver everything that queued up while we were offline,
// runs the requested action, saves the updated keys and disconnects. Nothing
// stays running between calls.

import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import pino from "pino";
import type { Store, StoredMessage } from "../store";
import { clearAuth, redisAuthState, type RawKV } from "./auth";

const LOCK = "wa:lock";
const LAST_SYNC = "wa:last-sync";

export type SessionDeps = { raw: RawKV; store: Store };

export class NotPairedError extends Error {
  constructor() {
    super("WhatsApp is not linked yet. Open /personal on this deployment and link your phone with a pairing code.");
  }
}

export class LoggedOutError extends Error {
  constructor() {
    super("WhatsApp logged this device out (it was removed from Linked devices, or the session expired). Open /personal and link again.");
  }
}

// ---------- message conversion ----------

function unwrap(m: any): any {
  if (!m) return m;
  return unwrap(m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m.editedMessage?.message) ?? m;
}

export function toStored(msg: WAMessage): StoredMessage | null {
  const key = msg.key;
  const chat = key?.remoteJid;
  if (!chat || !key.id || chat === "status@broadcast" || !msg.message) return null;
  const m = unwrap(msg.message);
  if (m.protocolMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;

  const type = Object.keys(m).find((k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage") ?? "unknown";
  const out: StoredMessage = {
    id: key.id,
    waId: chat,
    direction: key.fromMe ? "out" : "in",
    type: type.replace(/Message$/, ""),
    timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
  };
  const participant = key.participantAlt ?? key.participant ?? (key.fromMe ? undefined : key.remoteJidAlt ?? chat);
  if (participant) out.sender = participant.split("@")[0].split(":")[0];
  if (msg.pushName && !key.fromMe) out.senderName = msg.pushName;

  out.text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    undefined;
  if (m.reactionMessage) {
    out.type = "reaction";
    out.reaction = { messageId: m.reactionMessage.key?.id ?? "", emoji: m.reactionMessage.text ?? "" };
    out.text = m.reactionMessage.text ? `reacted ${m.reactionMessage.text}` : "removed a reaction";
  }
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const p = m.pollCreationMessage ?? m.pollCreationMessageV3;
    out.text = `[poll] ${p.name}: ${(p.options ?? []).map((o: any) => o.optionName).join(" / ")}`;
  }
  if (m.locationMessage) out.text = `[location] ${m.locationMessage.name ?? ""} ${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`.trim();
  if (m.contactMessage) out.text = `[contact] ${m.contactMessage.displayName ?? ""}`;
  for (const t of ["image", "video", "audio", "document", "sticker"]) {
    const media = m[`${t}Message`];
    if (media) {
      out.type = t;
      out.mime = media.mimetype ?? undefined;
      if (media.caption) out.caption = media.caption;
      if (media.fileName) out.filename = media.fileName;
    }
  }
  const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.videoMessage?.contextInfo;
  if (ctx?.stanzaId) out.replyTo = ctx.stanzaId;
  if (out.direction === "out") out.status = "sent";
  if (!out.text && !out.caption && !out.filename && !out.reaction && !["image", "video", "audio", "sticker"].includes(out.type)) return null;
  return out;
}

export type Downloaded = { bytes: Buffer; mime: string; name: string };
const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

async function ingest(store: Store, messages: WAMessage[], fresh?: StoredMessage[], grab?: { sock: () => WASocket; files: Map<string, Downloaded> }) {
  let n = 0;
  for (const msg of messages) {
    const s = toStored(msg);
    if (!s) continue;
    // Only messages we have never stored count as new, so replays never re-trigger flows.
    const isNew = fresh ? !(await store.getMessage(s.id)) : false;
    await store.saveMessage(s);
    if (s.senderName && !s.waId.endsWith("@g.us")) await store.setName(s.waId, s.senderName);
    if (isNew) fresh!.push(s);
    // Your own files (to the assistant) are downloaded now, while the connection is open.
    if (isNew && grab && s.direction === "out" && MEDIA_TYPES.has(s.type)) {
      try {
        const bytes = (await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }) as any, reuploadRequest: grab.sock().updateMediaMessage })) as Buffer;
        const ext = (s.mime ?? "").split("/")[1]?.split(";")[0] || "bin";
        grab.files.set(s.id, { bytes, mime: s.mime ?? "application/octet-stream", name: s.filename || `${s.type}-${s.id.slice(0, 6)}.${ext}` });
      } catch (e) {
        console.error("media download failed", e);
      }
    }
    n++;
  }
  return n;
}

// ---------- the session ----------

export type RunOptions = {
  /** Wait for queued offline messages before running the action (default true). */
  drain?: boolean;
  /** Hard cap for the whole connection, in ms. */
  maxMs?: number;
  /**
   * Runs after the offline messages are stored and before `action`, with the
   * connection still open. `fresh` lists messages that arrived live since the
   * last connection. Failures here never fail the sync.
   */
  afterDrain?: (ctx: { sock: WASocket; fresh: StoredMessage[]; files: Map<string, Downloaded>; deadline: number }) => Promise<void>;
};

export type RunResult<T> = { result: T; ingested: number };

async function acquireLock(raw: RawKV, ttlSec: number, waitMs: number) {
  const token = Math.random().toString(36).slice(2);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (await raw.set(LOCK, token, { nx: true, ex: ttlSec })) return token;
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("Another WhatsApp request is still running; try again in a few seconds.");
}

async function releaseLock(raw: RawKV, token: string) {
  if ((await raw.get(LOCK)) === token) await raw.del(LOCK);
}

export async function lastSync(raw: RawKV): Promise<number | null> {
  const v = await raw.get(LAST_SYNC);
  return v ? Number(v) : null;
}

/**
 * Opens the session, drains offline messages into the store, runs `action`,
 * then disconnects cleanly. Only one connection runs at a time (Redis lock),
 * because WhatsApp drops a device that connects twice.
 */
export async function withWhatsApp<T>({ raw, store }: SessionDeps, action: (sock: WASocket) => Promise<T>, opts: RunOptions = {}): Promise<RunResult<T>> {
  const { drain = true, maxMs = 50_000 } = opts;
  const lock = await acquireLock(raw, Math.ceil(maxMs / 1000) + 15, 20_000);
  const auth = await redisAuthState(raw);
  if (!auth.state.creds.registered) {
    await releaseLock(raw, lock);
    throw new NotPairedError();
  }

  let ingested = 0;
  const fresh: StoredMessage[] = [];
  const track = opts.afterDrain ? fresh : undefined;
  const files = new Map<string, Downloaded>();
  let lastEvent = Date.now();
  const work = new Set<Promise<unknown>>();
  const bg = (p: Promise<unknown>) => {
    const q = p.catch((e) => console.error("whatsapp ingest failed", e));
    work.add(q);
    q.finally(() => work.delete(q));
  };
  const sock = makeWASocket({
    auth: auth.state,
    browser: Browsers.macOS("Desktop"),
    logger: pino({ level: "silent" }) as any,
    markOnlineOnConnect: false, // keep the phone getting notifications
    syncFullHistory: false,
    printQRInTerminal: false,
  } as any);
  sock.ev.on("creds.update", auth.saveCreds);
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    lastEvent = Date.now();
    bg(ingest(store, messages, type === "notify" ? track : undefined, type === "notify" && track ? { sock: () => sock, files } : undefined).then((n) => (ingested += n)));
  });
  sock.ev.on("messaging-history.set", ({ messages, contacts }) => {
    lastEvent = Date.now();
    for (const c of contacts ?? []) if (c.id && (c.name || c.notify)) bg(store.setName(c.id, (c.name || c.notify)!));
    bg(ingest(store, messages).then((n) => (ingested += n)));
  });
  sock.ev.on("chats.upsert", (chats) => {
    for (const c of chats) if (c.id && c.name) bg(store.setName(c.id, c.name));
  });
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups) if (g.id && g.subject) bg(store.setName(g.id, g.subject));
  });

  const deadline = Date.now() + maxMs;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Timed out connecting to WhatsApp.")), Math.min(25_000, maxMs));
      sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          clearTimeout(t);
          resolve();
        }
        if (connection === "close") {
          clearTimeout(t);
          const code = (lastDisconnect?.error as any)?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) reject(new LoggedOutError());
          else reject(new Error(`WhatsApp closed the connection (${code ?? "unknown"}). Try again.`));
        }
      });
    });

    if (drain) {
      // Offline messages arrive in a burst right after connecting; stop once
      // it has been quiet for a moment.
      const drainUntil = Math.min(deadline - 10_000, Date.now() + 15_000);
      await new Promise((r) => setTimeout(r, 2_500));
      while (Date.now() - lastEvent < 2_500 && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 500));
    }

    if (opts.afterDrain) {
      while (work.size) await Promise.allSettled([...work]);
      try {
        await opts.afterDrain({ sock, fresh, files, deadline: deadline - 6_000 });
      } catch (e) {
        console.error("flows failed", e);
      }
    }

    const result = await action(sock);
    while (work.size) await Promise.allSettled([...work]);
    await raw.set(LAST_SYNC, String(Math.floor(Date.now() / 1000)));
    await new Promise((r) => setTimeout(r, 400)); // let trailing acks/creds land
    return { result, ingested };
  } catch (e) {
    if (e instanceof LoggedOutError) await clearAuth(raw);
    throw e;
  } finally {
    try {
      sock.end(undefined);
    } catch {}
    while (work.size) await Promise.allSettled([...work]);
    await auth.flush();
    await releaseLock(raw, lock);
  }
}

/** Normalises a phone number or JID into a WhatsApp JID. */
export function toJid(input: string): string {
  const s = input.trim();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error(`"${input}" is not a valid phone number: use the full number with country code, e.g. 966501234567`);
  return `${digits}@s.whatsapp.net`;
}
