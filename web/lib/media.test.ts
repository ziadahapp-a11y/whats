import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlobUrl, mediaKind, mediaProblem } from "./media";

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

test("only our own Blob store's URLs are sent to Meta", () => {
  assert.ok(isBlobUrl("https://abc123.public.blob.vercel-storage.com/inbox/a-x1.pdf"));
  assert.ok(!isBlobUrl("http://abc123.public.blob.vercel-storage.com/a.pdf"));
  assert.ok(!isBlobUrl("https://evil.example/a.public.blob.vercel-storage.com"));
  assert.ok(!isBlobUrl("https://public.blob.vercel-storage.com.evil.example/a.pdf"));
  assert.ok(!isBlobUrl("not a url"));
});
