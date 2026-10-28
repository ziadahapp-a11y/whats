// Attachments on their way from the inbox to Meta. A function accepts at most 4.5 MB per request,
// so the browser sends a file in 2 MB pieces; they wait in Redis for an hour at most and are
// deleted as soon as the file has been handed to Meta.

import type { RawKV } from "./wa/auth";

export const PIECE_BYTES = 2 * 1024 * 1024;
const SLICE = 400_000; // base64 chars per Redis value, like lib/files.ts
const TTL = 3600;
const MAX_PIECES = 60; // 120 MB, above Meta's 100 MB document limit

export type UploadMeta = { name: string; mime: string; size: number; pieces: number };

const head = (id: string) => `up:${id}`;
const slice = (id: string, piece: number, n: number) => `up:${id}:${piece}:${n}`;
const count = (id: string, piece: number) => `up:${id}:${piece}`;

export const validUploadId = (id: string) => /^[a-f0-9]{32}$/.test(id);

/** Stores one piece; piece 0 also records what the whole file is. */
export async function putPiece(raw: RawKV, id: string, piece: number, bytes: Buffer, meta?: UploadMeta) {
  if (!validUploadId(id)) throw new Error("bad upload id");
  if (!Number.isInteger(piece) || piece < 0 || piece >= MAX_PIECES) throw new Error("bad piece number");
  if (bytes.length > PIECE_BYTES) throw new Error("piece too large");
  if (piece === 0) {
    if (!meta || meta.pieces < 1 || meta.pieces > MAX_PIECES) throw new Error("bad upload description");
    await raw.set(head(id), JSON.stringify(meta), { ex: TTL });
  }
  const b64 = bytes.toString("base64");
  const n = Math.max(1, Math.ceil(b64.length / SLICE));
  for (let i = 0; i < n; i++) await raw.set(slice(id, piece, i), b64.slice(i * SLICE, (i + 1) * SLICE), { ex: TTL });
  await raw.set(count(id, piece), String(n), { ex: TTL });
}

/** The whole file, or null when it is missing, incomplete or expired. */
export async function loadUpload(raw: RawKV, id: string): Promise<(UploadMeta & { bytes: Buffer }) | null> {
  if (!validUploadId(id)) return null;
  const h = await raw.get(head(id));
  if (!h) return null;
  const meta = JSON.parse(h) as UploadMeta;
  const parts: Buffer[] = [];
  for (let p = 0; p < meta.pieces; p++) {
    const n = Number(await raw.get(count(id, p)));
    if (!n) return null;
    let b64 = "";
    for (let i = 0; i < n; i++) {
      const s = await raw.get(slice(id, p, i));
      if (s == null) return null;
      b64 += s;
    }
    parts.push(Buffer.from(b64, "base64"));
  }
  const bytes = Buffer.concat(parts);
  return bytes.length === meta.size ? { ...meta, bytes } : null;
}

export async function dropUpload(raw: RawKV, id: string) {
  if (!validUploadId(id)) return;
  const h = await raw.get(head(id));
  const pieces = h ? (JSON.parse(h) as UploadMeta).pieces : 0;
  const keys = [head(id)];
  for (let p = 0; p < pieces; p++) {
    const n = Number(await raw.get(count(id, p))) || 0;
    keys.push(count(id, p));
    for (let i = 0; i < n; i++) keys.push(slice(id, p, i));
  }
  await raw.del(...keys);
}
