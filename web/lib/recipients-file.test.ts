import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseRecipientsFile, RecipientsFileError } from "./recipients-file";
import { preflight } from "./preflight";

async function xlsx(sheets: unknown[][][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  sheets.forEach((rows, i) => {
    const ws = wb.addWorksheet(i === 0 ? "Customers" : `Sheet${i + 1}`);
    rows.forEach((r) => ws.addRow(r));
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const reject = (data: Uint8Array, name: string, pattern: RegExp, opts = {}) =>
  assert.rejects(
    () => parseRecipientsFile(data, name, opts),
    (e: Error) => e instanceof RecipientsFileError && pattern.test(e.message),
  );

test("reads dates, numbers, formulas and rich text from an Excel file", async () => {
  const data = await xlsx([
    [
      ["الجوال", "تاريخ التسجيل", "var1", "var2", "ignored"],
      ["0501234567", new Date(Date.UTC(2026, 8, 1)), "أحمد", "SUMMER20", "x"], // a real date cell
      [966502345678, "2026-09-15", "سارة", "A1"], // numeric phone, ISO text date
      [],
      ["٠٥٠٣٤٥٦٧٨٩", 46_000, "خالد", { formula: "A1&B1", result: "SUMMER30" }], // Arabic digits, Excel serial, formula
      ["0504567890", "01/10/2026", { richText: [{ text: "ن" }, { text: "ورة" }] }, 20],
      ["0505678901", new Date(Date.UTC(2026, 8, 2)), "", "B2"],
    ],
    [],
  ]);
  const p = await parseRecipientsFile(data, "list.xlsx");
  assert.equal(p.paramCount, 2);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /2 sheets/);
  assert.deepEqual(p.rows.map((r) => r.sourceRow), [2, 3, 5, 6, 7], "blank rows are skipped and rows keep their spreadsheet number");
  assert.deepEqual(p.rows.map((r) => r.params), [["أحمد", "SUMMER20"], ["سارة", "A1"], ["خالد", "SUMMER30"], ["نورة", "20"], ["", "B2"]]);
  assert.equal((p.rows[0].consentAt as Date).toISOString().slice(0, 10), "2026-09-01");
  assert.equal(p.rows[1].consentAt, "2026-09-15");
  assert.equal((p.rows[2].consentAt as Date).toISOString().slice(0, 10), "2025-12-09", "an Excel serial number becomes its date");
  assert.equal(p.rows[3].consentAt, "01/10/2026", "an ambiguous text date is passed on for the preflight to refuse");
  assert.ok(p.rows.every((r) => r.consentSource === "dashboard"));
});

test("the rows feed the preflight, which blocks what the file cannot settle", async () => {
  const data = await xlsx([
    [
      ["phone", "consent_date", "var1"],
      ["0501234567", new Date(Date.UTC(2026, 8, 1)), "أحمد"],
      ["0502345678", "01/10/2026", "سارة"],
      ["0503456789", "2026-09-02", ""],
      ["not a number", "2026-09-02", "x"],
    ],
  ]);
  const p = await parseRecipientsFile(data, "list.xlsx");
  const report = preflight({
    phone: { status: "CONNECTED", code_verification_status: "VERIFIED", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" },
    template: { name: "t", language: "ar", status: "APPROVED", category: "MARKETING", paramCount: p.paramCount },
    language: "ar",
    now: Date.parse("2026-10-28"),
    rows: p.rows,
    optedOut: new Set(),
    lastMarketingAt: new Map(),
    recent24h: new Set(),
  });
  assert.deepEqual(report.accepted.map((a) => a.sourceRow), [2]);
  assert.deepEqual(report.blocked.map((b) => [p.rows[b.row - 1].sourceRow, b.reason]), [[3, "invalid_consent_date"], [4, "missing_param"], [5, "invalid_phone"]]);
});

test("a CSV keeps every cell as text, handles a BOM and the semicolon delimiter", async () => {
  const csv = Buffer.from("﻿phone;consent_date;var1;var2\r\n0501234567;2026-09-01;أحمد;007\r\n0502345678;2026-09-02;سارة;A1\r\n");
  const p = await parseRecipientsFile(csv, "list.CSV");
  assert.deepEqual(p.rows.map((r) => [r.phone, r.consentAt, r.params]), [
    ["0501234567", "2026-09-01", ["أحمد", "007"]],
    ["0502345678", "2026-09-02", ["سارة", "A1"]],
  ]);
  const comma = await parseRecipientsFile(Buffer.from("phone,consent_date\n0501234567,2026-09-01\n"), "a.csv");
  assert.equal(comma.paramCount, 0);
  assert.equal(comma.rows.length, 1);
});

test("header aliases and spacing are understood", async () => {
  const data = await xlsx([[[" Phone Number ", "Consent-Date", "VAR1"], ["0501234567", "2026-09-01", "x"]]]);
  const p = await parseRecipientsFile(data, "a.xlsx", { consentSource: "signup form" });
  assert.equal(p.rows[0].consentSource, "signup form");
  assert.equal(p.paramCount, 1);
});

test("bad files are refused with a clear reason", async () => {
  await reject(await xlsx([[["phone", "var1"], ["0501234567", "a"]]]), "a.xlsx", /Missing column\(s\): consent_date\. Found: phone, var1/);
  await reject(await xlsx([[["consent_date"], ["2026-01-01"]]]), "a.xlsx", /Missing column\(s\): phone/);
  await reject(await xlsx([[["phone", "consent_date", "var1", "var3"], ["0501234567", "2026-01-01", "a", "b"]]]), "a.xlsx", /found var1, var3/);
  await reject(await xlsx([[["phone", "consent_date"]]]), "a.xlsx", /no customer rows/);
  await reject(await xlsx([[]]), "a.xlsx", /empty|Missing column/);
  await reject(new Uint8Array(10), "a.xls", /Unsupported file type/);
  await reject(new Uint8Array([1, 2, 3, 4]), "a.xlsx", /Could not read the file/);
  await reject(new Uint8Array(100), "a.xlsx", /limit is/, { maxBytes: 50 });
  const rows = [["phone", "consent_date"], ...Array.from({ length: 6 }, (_, i) => [`05000000${i}0`, "2026-01-01"])];
  await reject(await xlsx([rows]), "a.xlsx", /More than 5 rows/, { maxRows: 5 });
});
