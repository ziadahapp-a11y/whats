import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaKind, mediaProblem } from "./media";
import { dropUpload, loadUpload, PIECE_BYTES, putPiece } from "./upload";
import { MemoryRawKV } from "./wa/auth";
import { Graph } from "./graph";

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
