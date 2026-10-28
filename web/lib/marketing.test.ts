import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { readConfig } from "./config";
import { loadUpload, saveUpload, storageProblem, submitTemplate } from "./marketing";
import { MemoryKV, Store } from "./store";
import type { TemplateDraft } from "./template-lint";

test("campaigns refuse to run without Redis", () => {
  assert.match(storageProblem(readConfig({}), {})!, /Redis/);
  assert.equal(storageProblem(readConfig({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" }), {}), null);
  assert.equal(storageProblem(readConfig({}), { ALLOW_MEMORY_STORE: "1" }), null, "local development");
});

test("an uploaded list is kept by id with masked samples", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("a");
  ws.addRow(["phone", "consent_date", "var1"]);
  ws.addRow(["0501234567", new Date(Date.UTC(2026, 8, 1)), "أحمد"]);
  ws.addRow(["0502345678", "2026-09-02", "سارة"]);
  const data = new Uint8Array(await wb.xlsx.writeBuffer());

  const store = new Store(new MemoryKV());
  const summary = await saveUpload(store, data, "customers.xlsx");
  assert.equal(summary.rows, 2);
  assert.equal(summary.paramCount, 1);
  assert.equal(summary.sample[0].phone, "0501****567");
  assert.equal(summary.sample[0].consentAt, "2026-09-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(summary).includes("0501234567"), "the summary never carries a full number");

  const saved = await loadUpload(store, summary.uploadId);
  assert.equal(saved?.filename, "customers.xlsx");
  assert.deepEqual(saved?.rows.map((r) => [r.phone, r.consentAt, r.params, r.sourceRow]), [
    ["0501234567", "2026-09-01T00:00:00.000Z", ["أحمد"], 2],
    ["0502345678", "2026-09-02", ["سارة"], 3],
  ]);
  assert.equal(await loadUpload(store, "missing"), null);
  await assert.rejects(() => saveUpload(store, new Uint8Array([1, 2]), "a.xlsx"), /Could not read/);
});

const draft: TemplateDraft = {
  name: "summer_offer",
  language: "ar",
  body: "هلا {{1}}، عندنا خصم خاص لك على جميع المنتجات لمدة محدودة، استخدم الكود لخصمك عند الدفع وخذ خصمك الآن.",
  bodyExamples: ["أحمد"],
  buttons: [{ type: "QUICK_REPLY", text: "إيقاف" }],
};

test("a template is sent to Meta only when asked and only when it passes", async () => {
  const sent: unknown[] = [];
  const graph = { createTemplate: async (p: Record<string, unknown>) => (sent.push(p), { id: "T1", status: "PENDING", category: "MARKETING" }) };

  const preview = await submitTemplate(graph, draft, false);
  assert.equal(preview.ok && preview.submitted, false);
  assert.equal(sent.length, 0);

  const bad = await submitTemplate(graph, { ...draft, body: "{{1}} مرحبا" }, true);
  assert.equal(bad.ok, false);
  assert.equal(sent.length, 0, "a draft with errors never reaches Meta");

  const done = await submitTemplate(graph, draft, true);
  assert.equal(done.ok && done.submitted, true);
  assert.deepEqual(done.ok && done.meta, { id: "T1", status: "PENDING", category: "MARKETING" });
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as any).category, "MARKETING");
});
