import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaKind, mediaProblem } from "./media";
import { dropUpload, loadUpload, PIECE_BYTES, putPiece } from "./upload";
import { MemoryRawKV } from "./wa/auth";
import { Graph } from "./graph";
import { sendableTemplates } from "./inbox";
import { compileTemplate } from "./template-lint";
import { SUGGESTED_TEMPLATES } from "./suggested-templates";

const MB = 1024 * 1024;

test("attachments follow Meta's types and size limits", () => {
  assert.equal(mediaKind("image/png"), "image");
  assert.equal(mediaKind("application/pdf"), "document");
  assert.equal(mediaKind("image/gif"), null);
  assert.equal(mediaProblem("image/jpeg", 5 * MB), null);
  assert.match(mediaProblem("image/jpeg", 5 * MB + 1)!, /5 ميقا/);
  assert.equal(mediaProblem("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 100 * MB), null);
  assert.match(mediaProblem("application/pdf", 100 * MB + 1)!, /100 ميقا/);
  assert.match(mediaProblem("application/zip", 10)!, /غير مدعوم/);
});

test("an attachment sent in pieces comes back whole, and is gone after dropUpload", async () => {
  const raw = new MemoryRawKV();
  const id = "a".repeat(32);
  const file = Buffer.alloc(PIECE_BYTES + 1234, 7);
  file[PIECE_BYTES] = 9;
  const meta = { name: "عرض.pdf", mime: "application/pdf", size: file.length, pieces: 2 };
  await putPiece(raw, id, 0, file.subarray(0, PIECE_BYTES), meta);
  assert.equal(await loadUpload(raw, id), null); // second piece still missing
  await putPiece(raw, id, 1, file.subarray(PIECE_BYTES));
  const got = await loadUpload(raw, id);
  assert.ok(got && got.bytes.equals(file));
  assert.equal(got!.name, "عرض.pdf");
  await dropUpload(raw, id);
  assert.equal(await loadUpload(raw, id), null);
  await assert.rejects(putPiece(raw, "../x", 0, Buffer.from("x"), meta), /bad upload id/);
  await assert.rejects(putPiece(raw, id, 0, Buffer.alloc(PIECE_BYTES + 1)), /too large/);
});

test("uploadMedia posts the file to Meta and returns its id", async () => {
  let seen: { url: string; form: FormData } | undefined;
  const fake = (async (url: URL, init: RequestInit) => {
    seen = { url: String(url), form: init.body as FormData };
    return new Response(JSON.stringify({ id: "MEDIA9" }), { status: 200 });
  }) as unknown as typeof fetch;
  const graph = new Graph({ accessToken: "t", phoneNumberId: "PN1" } as any, fake);
  assert.equal(await graph.uploadMedia(Buffer.from("pdf"), "application/pdf", "a.pdf"), "MEDIA9");
  assert.match(seen!.url, /\/PN1\/media$/);
  assert.equal(seen!.form.get("messaging_product"), "whatsapp");
  assert.equal((seen!.form.get("file") as File).name, "a.pdf");
});

test("the inbox offers approved templates with what each needs", () => {
  const list = sendableTemplates([
    { name: "a", language: "ar", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "هلا {{1}}، طلبك {{2}} و{{1}}" }] },
    { name: "b", language: "ar", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "عرض" }] },
    { name: "c", language: "ar", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "x" }] },
    { name: "d", language: "ar", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "TEXT", text: "هلا {{1}}" }, { type: "BODY", text: "x" }] },
  ]);
  assert.deepEqual(list.map((t) => [t.name, t.params, t.header]), [["a", 2, null], ["b", 0, "IMAGE"]]);
});

test("utility templates compile as UTILITY without the opt-out warning", () => {
  const r = compileTemplate({ name: "ziadah_case_update", language: "ar", category: "UTILITY", body: "هلا {{1}}، عندنا تحديث بخصوص طلبك.", bodyExamples: ["محمد"] });
  assert.ok(r.ok);
  assert.equal(r.ok && r.payload.category, "UTILITY");
  assert.ok(r.ok && !r.warnings.some((w) => w.field === "buttons"));
  const m = compileTemplate({ name: "x_offer", language: "ar", body: "هلا {{1}}، عندنا عرض خاص لك هذا الأسبوع.", bodyExamples: ["محمد"] });
  assert.equal(m.ok && m.payload.category, "MARKETING");
});

test("every ready-made Ziadah template passes the checks", () => {
  for (const t of SUGGESTED_TEMPLATES) {
    const r = compileTemplate({
      name: t.name, language: "ar", category: t.category, body: t.body, bodyExamples: t.examples, footer: t.footer,
      ...(t.image ? { header: { type: "IMAGE" as const, handle: "h" } } : {}),
      buttons: [...(t.optOut ? [{ type: "QUICK_REPLY" as const, text: "إيقاف" }] : []), ...(t.url ? [{ type: "URL" as const, text: t.urlText!, url: t.url }] : [])],
    });
    assert.ok(r.ok, `${t.name}: ${JSON.stringify(!r.ok && r.issues)}`);
  }
});

test("uploadHeaderHandle runs Meta's resumable upload and returns the handle", async () => {
  const calls: string[] = [];
  const fake = (async (url: URL, init: RequestInit) => {
    calls.push(`${init.method} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/APP1/uploads")) return new Response(JSON.stringify({ id: "upload:XYZ" }));
    return new Response(JSON.stringify({ h: "4::HANDLE" }));
  }) as unknown as typeof fetch;
  const graph = new Graph({ accessToken: "t", phoneNumberId: "PN1", appId: "APP1", graphVersion: "v26.0" } as any, fake);
  assert.equal(await graph.uploadHeaderHandle(Buffer.from("png"), "image/png", "a.png"), "4::HANDLE");
  assert.match(calls[0], /POST \/v26\.0\/APP1\/uploads\?file_name=a\.png&file_length=3&file_type=image%2Fpng/);
  assert.match(calls[1], /POST \/v26\.0\/upload:XYZ/);
});
