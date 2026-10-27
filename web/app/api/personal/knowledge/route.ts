import { admin, err } from "@/lib/admin";
import { aiFromEnv } from "@/lib/flows/ai";
import { extractFile, fetchPage } from "@/lib/kb/extract";
import { addDoc, knowledgeContext, LIMITS, listDocs, removeDocs, setEnabled } from "@/lib/kb/store";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel rejects request bodies above ~4.5MB

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const docs = await listDocs(a.base);
  return Response.json({ docs, limits: LIMITS, chars: docs.reduce((n, d) => n + d.chars, 0) });
}

// JSON: { op: "url"|"text"|"refresh"|"toggle"|"ask", ... }   multipart: file upload (<= 4MB)
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  try {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (!files.length) return err("Choose a file.", 400);
      const added = [];
      for (const f of files) {
        if (f.size > MAX_UPLOAD) return err(`${f.name} is larger than 4MB. Split it or add it by link.`, 413);
        const x = await extractFile(f.name, new Uint8Array(await f.arrayBuffer()), f.type);
        added.push(await addDoc(a.base, { title: x.title || f.name, kind: "file", source: f.name, text: x.text }));
      }
      return Response.json({ ok: true, added });
    }
    const b = (await req.json().catch(() => ({}))) as { op?: string; url?: string; crawl?: boolean; pages?: number; title?: string; text?: string; id?: string; enabled?: boolean; q?: string };
    if (b.op === "text") {
      if (!b.text?.trim()) return err("Write some text.", 400);
      return Response.json({ ok: true, added: [await addDoc(a.base, { title: b.title?.trim() || "ملاحظة", kind: "text", source: "text", text: b.text })] });
    }
    if (b.op === "url") {
      if (!b.url) return err("Give a link.", 400);
      const first = await fetchPage(b.url, b.crawl ? new URL(b.url).pathname.replace(/[^/]*$/, "") : undefined);
      const group = b.crawl ? randomBytes(4).toString("hex") : undefined;
      const added = [await addDoc(a.base, { title: first.title, kind: "url", source: first.url, text: first.text, group })];
      if (b.crawl) {
        const seen = new Set([first.url]);
        const queue = first.links.filter((u) => !seen.has(u));
        const max = Math.min(Math.max(b.pages ?? 20, 1), 40);
        const deadline = Date.now() + 90_000;
        while (queue.length && added.length < max && Date.now() < deadline) {
          const u = queue.shift()!;
          if (seen.has(u)) continue;
          seen.add(u);
          try {
            const p = await fetchPage(u);
            if (p.text.length > 200) added.push(await addDoc(a.base, { title: p.title, kind: "url", source: p.url, text: p.text, group }));
          } catch {}
        }
      }
      return Response.json({ ok: true, added });
    }
    if (b.op === "refresh") {
      const d = (await listDocs(a.base)).find((x) => x.id === b.id);
      if (!d || d.kind !== "url") return err("Only link documents can be refreshed.", 404);
      const p = await fetchPage(d.source);
      return Response.json({ ok: true, added: [await addDoc(a.base, { id: d.id, title: p.title, kind: "url", source: p.url, text: p.text, group: d.group })] });
    }
    if (b.op === "toggle") {
      await setEnabled(a.base, b.id ?? "", !!b.enabled);
      return Response.json({ ok: true });
    }
    if (b.op === "ask") {
      const ai = aiFromEnv();
      if (!ai) return err("Add an AI key (ANTHROPIC_API_KEY or AI_COMPAT_*) in Vercel first.", 503);
      const q = (b.q ?? "").slice(0, 1000);
      const ctx = await knowledgeContext(a.base, q);
      if (!ctx) return err("The knowledge base is empty.", 400);
      const answer = await ai({ system: "Answer using only the knowledge below. If it is not there, say so.\n" + ctx, user: q, maxTokens: 600 });
      return Response.json({ ok: true, answer });
    }
    return err("unknown op", 400);
  } catch (e) {
    return err(e, e instanceof Error && /not supported|private|https|too large|limit/i.test(e.message) ? 400 : 500);
  }
}

export async function DELETE(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const p = new URL(req.url).searchParams;
  const id = p.get("id");
  const group = p.get("group");
  if (!id && !group) return err("id or group", 400);
  return Response.json({ ok: true, removed: await removeDocs(a.base, (d) => (id ? d.id === id : d.group === group)) });
}
