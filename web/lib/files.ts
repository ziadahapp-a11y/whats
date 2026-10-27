// Files that arrive in WhatsApp (photos, PDFs, anything) for the assistant.
// Stored in Redis in chunks for 24 hours, so a task confirmed a minute later still has
// its files, and handed to connectors through a temporary secret link.

import { randomBytes } from "node:crypto";
import type { RawKV } from "./wa/auth";

export const MAX_FILE = 3 * 1024 * 1024;
const CHUNK = 400_000; // base64 chars per Redis value
const TTL = 86_400;

export type Attachment = { id: string; token: string; name: string; mime: string; size: number; chunks: number };
export type Loaded = Attachment & { bytes: Buffer };

const head = (id: string) => `file:${id}`;
const part = (id: string, n: number) => `file:${id}:${n}`;

export async function saveFile(raw: RawKV, bytes: Buffer, mime: string, name: string): Promise<Attachment> {
  if (bytes.length > MAX_FILE) throw new Error(`The file is larger than ${MAX_FILE / 1024 / 1024}MB.`);
  const id = randomBytes(8).toString("hex");
  const b64 = bytes.toString("base64");
  const chunks = Math.max(1, Math.ceil(b64.length / CHUNK));
  for (let i = 0; i < chunks; i++) await raw.set(part(id, i), b64.slice(i * CHUNK, (i + 1) * CHUNK), { ex: TTL });
  const att: Attachment = { id, token: randomBytes(16).toString("hex"), name: name.slice(0, 120), mime: mime || "application/octet-stream", size: bytes.length, chunks };
  await raw.set(head(id), JSON.stringify(att), { ex: TTL });
  return att;
}

export async function loadFile(raw: RawKV, id: string): Promise<Loaded | null> {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const h = await raw.get(head(id));
  if (!h) return null;
  try {
    const att = JSON.parse(h) as Attachment;
    let b64 = "";
    for (let i = 0; i < att.chunks; i++) b64 += (await raw.get(part(id, i))) ?? "";
    return { ...att, bytes: Buffer.from(b64, "base64") };
  } catch {
    return null;
  }
}

/** Public base of this deployment, for links that connectors open. */
export function publicBase(env: Record<string, string | undefined> = process.env): string {
  const host = env.APP_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || "";
  return host ? (host.startsWith("http") ? host : `https://${host}`).replace(/\/$/, "") : "";
}

export const fileUrl = (base: string, a: Attachment) => (base ? `${base}/api/files/${a.id}?t=${a.token}` : "");
