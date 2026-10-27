import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryRawKV } from "./wa/auth";
import { MemoryKV, Store } from "./store";
import { assertPublicUrl, isPrivateIp, literalCheck, safeGet } from "./net";
import { extractFile, fetchPage, htmlToText, sameSiteLinks } from "./kb/extract";
import { buildContext, chunkText, rank, tokenize } from "./kb/retrieve";
import { addDoc, knowledgeContext, listDocs, LIMITS, loadSources, removeDocs, setEnabled } from "./kb/store";
import { runFlows, type Channel } from "./flows/engine";
import { FlowInput, type Flow } from "./flows/types";
import type { AiClient } from "./flows/ai";

test("private addresses are refused, public ones pass", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(literalCheck("http://example.com"), null);
  assert.equal(literalCheck("https://localhost/x"), null);
  assert.equal(literalCheck("https://user:pw@example.com/"), null);
  assert.equal(literalCheck("https://10.0.0.1/"), null);
  assert.ok(literalCheck("https://example.com/a"));
  await assert.rejects(assertPublicUrl("https://evil.test/", async () => ["10.0.0.5"]), /public https/);
  await assert.rejects(assertPublicUrl("https://evil.test/", async () => ["93.184.216.34", "127.0.0.1"]), /public https/);
  assert.equal(await assertPublicUrl("https://ok.test/p", async () => ["93.184.216.34"]), "https://ok.test/p");
});

test("safeGet re-checks redirects and the size cap", async () => {
  const resolve = async (h: string) => (h === "internal.test" ? ["10.0.0.1"] : ["93.184.216.34"]);
  const redirect = (async () => new Response(null, { status: 302, headers: { location: "https://internal.test/secret" } })) as unknown as typeof fetch;
  await assert.rejects(safeGet("https://ok.test/", { fetchImpl: redirect, resolve }), /public https/);
  const big = (async () => new Response("x".repeat(2000), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(safeGet("https://ok.test/", { fetchImpl: big, resolve, maxBytes: 1000 }), /larger/);
  const ok = (async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
  assert.equal(new TextDecoder().decode((await safeGet("https://ok.test/", { fetchImpl: ok, resolve })).bytes), "hello");
});

test("html becomes readable text, links stay on the site", () => {
  const html = `<html><head><title>Returns &amp; refunds</title><style>.a{}</style></head><body><nav>Home Menu</nav><main><h1>Returns</h1><p>Send it back within <b>14</b> days.</p><ul><li>Keep the box</li><li>Keep the receipt</li></ul><script>alert(1)</script></main><footer>© x</footer>
  <a href="/help/shipping">s</a><a href="https://other.com/x">o</a><a href="/blog/x">b</a><a href="/help/img.png">i</a></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, "Returns & refunds");
  assert.match(text, /Returns\nSend it back within 14 days\./);
  assert.match(text, /- Keep the box\n- Keep the receipt/);
  assert.ok(!/alert|Menu|©/.test(text));
  assert.deepEqual(sameSiteLinks(html, "https://shop.test/help/returns", "/help/"), ["https://shop.test/help/shipping"]);
});

test("files: markdown, docx and pdf are read", async () => {
  assert.equal((await extractFile("faq.md", new TextEncoder().encode("# FAQ\r\nأهلاً"))).text, "# FAQ\nأهلاً");
  const docx = await extractFile("policy.docx", readFileSync(new URL("./testdata/policy.docx", import.meta.url)));
  assert.equal(docx.title, "policy");
  assert.match(docx.text, /refund within 14 days/);
  const pdf = await extractFile("shipping.pdf", readFileSync(new URL("./testdata/shipping.pdf", import.meta.url)));
  assert.match(pdf.text, /Delivery inside Riyadh takes 1 day/);
  await assert.rejects(extractFile("old.doc", new Uint8Array([1])), /docx/);
  await assert.rejects(extractFile("a.exe", new Uint8Array([1])), /not supported/);
});

test("fetchPage reads html and pdf links", async () => {
  const html = `<title>Help</title><main><p>${"x ".repeat(30)}</p></main><a href="/help/a">a</a>`;
  const page = await fetchPage("https://h.test/help/", "/help/", async (u) => ({ url: u, status: 200, contentType: "text/html; charset=utf-8", bytes: new TextEncoder().encode(html) }));
  assert.equal(page.title, "Help");
  assert.deepEqual(page.links, ["https://h.test/help/a"]);
  const pdf = await fetchPage("https://h.test/s.pdf", undefined, async (u) => ({ url: u, status: 200, contentType: "application/pdf", bytes: readFileSync(new URL("./testdata/shipping.pdf", import.meta.url)) }));
  assert.match(pdf.text, /Shipping/);
});

test("retrieval finds the right chunk, in Arabic too", () => {
  assert.deepEqual(tokenize("الاسترجاع خلال 14 يوم"), ["استرجاع", "خلال", "14", "يوم"]);
  assert.deepEqual(tokenize("Refunds and shipping policies"), ["refund", "and", "shipp", "policy"].map((x) => (x === "shipp" ? "shipp" : x)).slice(0, 2).concat(tokenize("shipping"), ["policy"]));
  const filler = (w: string) => Array.from({ length: 60 }, (_, i) => `فقرة ${w} رقم ${i} تتكلم عن شي ثاني تماماً وفيها كلام كثير عن ${w}.`).join("\n\n");
  const sources = [
    { title: "الشحن", source: "", text: `${filler("التوصيل")}\n\nالتوصيل داخل الرياض يستغرق يوم واحد فقط.` },
    { title: "الاسترجاع", source: "", text: `${filler("المنتجات")}\n\nيمكن استرجاع المنتج خلال 14 يوم من الشراء مع الفاتورة.` },
  ];
  assert.ok(chunkText(sources[0].text).length > 3);
  const top = rank(sources, "كم يوم استرجاع المنتج؟")[0];
  assert.match(top.text, /استرجاع المنتج خلال 14 يوم/);
  const ctx = buildContext(sources, "كم يوم استرجاع المنتج؟", 3000);
  assert.ok(ctx.length <= 3400);
  assert.match(ctx, /### الاسترجاع/);
  assert.match(ctx, /14 يوم/);
  const small = buildContext([{ title: "T", source: "https://x.test", text: "short text" }], "q", 1000);
  assert.equal(small, "### T (https://x.test)\nshort text");
  assert.equal(buildContext([], "q"), "");
});

test("knowledge store: add, refresh in place, toggle, limits, remove", async () => {
  const base = new MemoryRawKV();
  const a = await addDoc(base, { title: "Refunds", kind: "text", source: "pasted", text: "Refunds within 14 days of purchase, paid in 5 business days." });
  const long = "ب".repeat(LIMITS.part * 2 + 10);
  const b = await addDoc(base, { title: "Long", kind: "file", source: "long.md", text: long });
  assert.equal(b.parts, 3);
  assert.ok((await loadSources(base, 0)).find((s) => s.title === "Long")!.text.length === long.length);

  const a2 = await addDoc(base, { id: a.id, title: "Refunds", kind: "text", source: "pasted", text: "Refunds within 30 days now, paid in 3 business days." });
  assert.equal(a2.id, a.id);
  assert.equal((await listDocs(base)).length, 2);
  assert.ok(/30 days now/.test(await knowledgeContext(base, "refund")));

  await setEnabled(base, a.id, false);
  assert.ok(!(await knowledgeContext(base, "refund")).includes("30 days"));
  await assert.rejects(addDoc(base, { title: "x", kind: "text", source: "", text: "tiny" }), /almost no text/);
  await assert.rejects(addDoc(base, { title: "Big", kind: "text", source: "", text: "ج".repeat(LIMITS.doc) }).then(() => addDoc(base, { title: "Big2", kind: "text", source: "", text: "ج".repeat(LIMITS.doc) })).then(() => addDoc(base, { title: "Big3", kind: "text", source: "", text: "ج".repeat(LIMITS.doc) })).then(() => addDoc(base, { title: "Big4", kind: "text", source: "", text: "ج".repeat(LIMITS.doc) })).then(() => addDoc(base, { title: "Big5", kind: "text", source: "", text: "ج".repeat(LIMITS.doc) })), /full/);
  assert.equal(await removeDocs(base, (d) => d.id === b.id), 1);
  assert.equal(await base.get(`meta:kb:p:${b.id}:0`), null);
});

test("Claude answers from the knowledge base and is told to stay inside it", async () => {
  const base = new MemoryRawKV();
  await addDoc(base, { title: "Refunds", kind: "text", source: "pasted", text: "Refunds are possible within 14 days of purchase with the receipt." });
  let system = "";
  const ai: AiClient = async (r) => ((system = r.system), "خلال 14 يوم مع الفاتورة");
  const flow = { ...FlowInput.parse({ name: "kb", mode: "auto", actions: [{ type: "ai_reply", prompt: "" }] }), id: "flow-kb", createdAt: 0, updatedAt: 0, activeFrom: 0 } as Flow;
  const sent: string[] = [];
  const channel: Channel = { account: "main", kind: "personal", sendText: async (_c, t) => (sent.push(t), "1"), react: async () => {}, markRead: async () => {}, resolveTarget: (t) => t };
  const store = new Store(new MemoryKV(), "p:");
  const m = { id: "m1", waId: "966500000001@s.whatsapp.net", direction: "in" as const, type: "text", text: "كم مدة الاسترجاع refund?", timestamp: Math.floor(Date.now() / 1000) };
  await store.saveMessage(m);
  await runFlows({ flows: [flow], state: new MemoryRawKV(), store, channel, ai, knowledge: (q) => knowledgeContext(base, q) }, [m]);
  assert.deepEqual(sent, ["خلال 14 يوم مع الفاتورة"]);
  assert.match(system, /<knowledge>[\s\S]*14 days of purchase[\s\S]*<\/knowledge>/);
  assert.match(system, /Do not state prices, policies/);

  // The plain `ai` action does not use it unless asked to.
  system = "";
  const plain = { ...flow, id: "flow-plain", actions: [{ type: "ai", prompt: "x", context: 5, maxTokens: 100, scope: "chat", hours: 24 }] } as Flow;
  await runFlows({ flows: [plain], state: new MemoryRawKV(), store, channel, ai, knowledge: (q) => knowledgeContext(base, q) }, [{ ...m, id: "m2" }]);
  assert.ok(!system.includes("<knowledge>"));
});
