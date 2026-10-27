// Turns links and uploaded files into plain text Claude can read.

import { safeGet, type Fetched } from "../net";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—" };

function decode(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html.match(/<(main|article)[\s>][\s\S]*<\/\1>/i)?.[0] ?? html.match(/<body[\s>][\s\S]*<\/body>/i)?.[0] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|footer|header|aside|form)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** Same-site links on a page, for crawling a help center. */
export function sameSiteLinks(html: string, base: string, prefix: string): string[] {
  const root = new URL(base);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decode(m[1]), base);
      u.hash = "";
      if (u.protocol !== "https:" || u.hostname !== root.hostname) continue;
      if (!u.pathname.startsWith(prefix)) continue;
      if (/\.(png|jpe?g|gif|svg|webp|css|js|ico|zip|mp4|woff2?)$/i.test(u.pathname)) continue;
      out.add(u.toString());
    } catch {
      /* skip bad links */
    }
  }
  return [...out];
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

export const SUPPORTED = ["pdf", "docx", "md", "markdown", "txt", "csv", "json", "html", "htm"];

/** Extracts the text of an uploaded or downloaded file. */
export async function extractFile(name: string, bytes: Uint8Array, mime = ""): Promise<{ title: string; text: string }> {
  const ext = extOf(name) || (mime.includes("pdf") ? "pdf" : mime.includes("wordprocessingml") ? "docx" : mime.includes("html") ? "html" : mime.includes("markdown") ? "md" : "txt");
  const base = name.replace(/\.[^.]+$/, "") || name;
  switch (ext) {
    case "pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return { title: base, text: String(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(bytes) });
      return { title: base, text: value.replace(/\n{3,}/g, "\n\n").trim() };
    }
    case "html":
    case "htm": {
      const h = htmlToText(textDecoder.decode(bytes));
      return { title: h.title || base, text: h.text };
    }
    case "md": case "markdown": case "txt": case "csv": case "json":
      return { title: base, text: textDecoder.decode(bytes).replace(/\r\n/g, "\n").trim() };
    case "doc":
      throw new Error("Old .doc files are not supported. Save it as .docx or PDF and upload that.");
    default:
      throw new Error(`.${ext || "?"} files are not supported. Use PDF, Word (.docx), Markdown, TXT, CSV, JSON or HTML.`);
  }
}

export type Page = { url: string; title: string; text: string; links: string[] };

/** Downloads a link and turns it into text (HTML, PDF, Word, Markdown or plain text). */
export async function fetchPage(raw: string, crawlPrefix?: string, get: (u: string) => Promise<Fetched> = (u) => safeGet(u)): Promise<Page> {
  const r = await get(raw);
  const path = new URL(r.url).pathname;
  const ct = r.contentType.toLowerCase();
  if (ct.includes("html") || (!ct && !/\.\w{2,5}$/.test(path))) {
    const html = textDecoder.decode(r.bytes);
    const { title, text } = htmlToText(html);
    return { url: r.url, title: title || new URL(r.url).hostname + path, text, links: crawlPrefix !== undefined ? sameSiteLinks(html, r.url, crawlPrefix) : [] };
  }
  const name = decodeURIComponent(path.split("/").pop() || "page");
  const f = await extractFile(name, r.bytes, ct);
  return { url: r.url, title: f.title, text: f.text, links: [] };
}
