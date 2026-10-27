// The knowledge base: documents Claude may use when it answers. Kept once per
// deployment in Redis as plain text, split into a few big parts per document so
// reading it takes a handful of requests, not hundreds.

import { randomBytes } from "node:crypto";
import type { RawKV } from "../wa/auth";
import { buildContext, type Source } from "./retrieve";

export type KbDoc = {
  id: string;
  title: string;
  kind: "url" | "file" | "text";
  source: string;
  /** documents fetched together (a crawled help center) share one group */
  group?: string;
  chars: number;
  parts: number;
  enabled: boolean;
  updatedAt: number;
  note?: string;
};

const DOCS = "meta:kb:docs";
const part = (id: string, n: number) => `meta:kb:p:${id}:${n}`;
export const LIMITS = { doc: 400_000, total: 2_000_000, part: 100_000, docs: 120 };

function parseDocs(v: string | null): KbDoc[] {
  try {
    const rows = v ? JSON.parse(v) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export const listDocs = async (base: RawKV) => parseDocs(await base.get(DOCS));

export type NewDoc = { title: string; kind: KbDoc["kind"]; source: string; text: string; group?: string; id?: string };

/** Adds a document, or replaces the one with the same `id` (refresh). */
export async function addDoc(base: RawKV, input: NewDoc, now = Date.now()): Promise<KbDoc> {
  const title = input.title.trim().slice(0, 120) || "بدون عنوان";
  let text = input.text.replace(/\u0000/g, "").trim();
  if (text.length < 20) throw new Error("There is almost no text in it. A scanned PDF or an image needs OCR first.");
  let note: string | undefined;
  if (text.length > LIMITS.doc) {
    text = text.slice(0, LIMITS.doc);
    note = `قُصّ إلى أول ${LIMITS.doc.toLocaleString("en")} حرف`;
  }
  const docs = await listDocs(base);
  const old = input.id ? docs.find((d) => d.id === input.id) : undefined;
  const others = docs.filter((d) => d.id !== old?.id);
  if (!old && others.length >= LIMITS.docs) throw new Error(`At most ${LIMITS.docs} documents.`);
  if (others.reduce((n, d) => n + d.chars, 0) + text.length > LIMITS.total) throw new Error(`The knowledge base is full (${LIMITS.total.toLocaleString("en")} characters). Remove something first.`);

  const id = old?.id ?? randomBytes(5).toString("hex");
  const parts = Math.ceil(text.length / LIMITS.part);
  for (let i = 0; i < parts; i++) await base.set(part(id, i), text.slice(i * LIMITS.part, (i + 1) * LIMITS.part));
  for (let i = parts; old && i < old.parts; i++) await base.del(part(id, i));
  const doc: KbDoc = { id, title, kind: input.kind, source: input.source.slice(0, 300), group: input.group ?? old?.group, chars: text.length, parts, enabled: old?.enabled ?? true, updatedAt: now, ...(note ? { note } : {}) };
  await base.set(DOCS, JSON.stringify([...others, doc].sort((a, b) => a.updatedAt - b.updatedAt)));
  cache = null;
  return doc;
}

export async function removeDocs(base: RawKV, match: (d: KbDoc) => boolean): Promise<number> {
  const docs = await listDocs(base);
  const gone = docs.filter(match);
  for (const d of gone) for (let i = 0; i < d.parts; i++) await base.del(part(d.id, i));
  await base.set(DOCS, JSON.stringify(docs.filter((d) => !match(d))));
  cache = null;
  return gone.length;
}

export async function setEnabled(base: RawKV, id: string, enabled: boolean) {
  const docs = await listDocs(base);
  await base.set(DOCS, JSON.stringify(docs.map((d) => (d.id === id ? { ...d, enabled } : d))));
  cache = null;
}

export async function readText(base: RawKV, d: KbDoc): Promise<string> {
  const parts = await Promise.all(Array.from({ length: d.parts }, (_, i) => base.get(part(d.id, i))));
  return parts.map((p) => p ?? "").join("");
}

let cache: { at: number; stamp: string; sources: Source[] } | null = null;

/** Every enabled document as text. Cached for a short while within one server instance. */
export async function loadSources(base: RawKV, ttlMs = 30_000): Promise<Source[]> {
  const raw = await base.get(DOCS);
  if (cache && cache.stamp === raw && Date.now() - cache.at < ttlMs) return cache.sources;
  const docs = parseDocs(raw).filter((d) => d.enabled);
  const sources = await Promise.all(docs.map(async (d) => ({ title: d.title, source: d.kind === "url" ? d.source : "", text: await readText(base, d) })));
  cache = { at: Date.now(), stamp: raw ?? "", sources };
  return sources;
}

export async function knowledgeContext(base: RawKV, query: string, maxChars = 40_000): Promise<string> {
  return buildContext(await loadSources(base), query, maxChars);
}
