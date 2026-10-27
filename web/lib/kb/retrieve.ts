// Picks the parts of the knowledge base that matter for one question.
// Small knowledge bases go into the prompt whole. Bigger ones are split into
// chunks and ranked with BM25 on the words of the conversation, so no
// embedding service is needed.

import { norm } from "../flows/engine";

export type Source = { title: string; source: string; text: string };

/** Light stemming: Arabic "ال" and common English endings, so "refunds" finds "refund". */
function strip(w: string): string {
  if (w.length > 4 && w.startsWith("ال")) return w.slice(2);
  if (/^[a-z]+$/.test(w)) {
    if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  }
  return w;
}

export function tokenize(s: string): string[] {
  return norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
    .map(strip);
}

/** Splits at paragraph breaks into pieces of about `size` characters. */
export function chunkText(text: string, size = 1400): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > size) {
      out.push(cur);
      cur = "";
    }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

type Chunk = { doc: number; text: string; tf: Map<string, number>; len: number };

export function rank(sources: Source[], query: string): { doc: number; text: string; score: number }[] {
  const chunks: Chunk[] = [];
  sources.forEach((s, doc) => {
    for (const text of chunkText(s.text)) {
      const tf = new Map<string, number>();
      // The title counts for every chunk of its document.
      const toks = tokenize(`${s.title} ${text}`);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      chunks.push({ doc, text, tf, len: toks.length });
    }
  });
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return chunks.map((c) => ({ doc: c.doc, text: c.text, score: 0 }));
  const avg = chunks.reduce((n, c) => n + c.len, 0) / chunks.length || 1;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, chunks.filter((c) => c.tf.has(t)).length);
  const k1 = 1.5;
  const b = 0.75;
  return chunks
    .map((c) => {
      let score = 0;
      for (const t of q) {
        const f = c.tf.get(t) ?? 0;
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * c.len) / avg));
      }
      return { doc: c.doc, text: c.text, score };
    })
    .sort((a, z) => z.score - a.score);
}

/** The knowledge to show Claude for `query`, at most `maxChars` characters. */
export function buildContext(sources: Source[], query: string, maxChars = 40_000): string {
  if (!sources.length) return "";
  const head = (s: Source) => `### ${s.title}${s.source ? ` (${s.source})` : ""}`;
  const total = sources.reduce((n, s) => n + s.text.length + s.title.length + 20, 0);
  if (total <= maxChars) return sources.map((s) => `${head(s)}\n${s.text}`).join("\n\n");
  const picked: { doc: number; text: string }[] = [];
  let used = 0;
  for (const c of rank(sources, query)) {
    if (c.score <= 0 && picked.length >= 3) break;
    if (used + c.text.length > maxChars) continue;
    picked.push(c);
    used += c.text.length + 8;
    if (used >= maxChars) break;
  }
  // Keep each document's pieces together, in the document's own order.
  const byDoc = new Map<number, string[]>();
  for (const c of picked) byDoc.set(c.doc, [...(byDoc.get(c.doc) ?? []), c.text]);
  return [...byDoc.entries()].map(([doc, parts]) => `${head(sources[doc])}\n${parts.join("\n…\n")}`).join("\n\n");
}
