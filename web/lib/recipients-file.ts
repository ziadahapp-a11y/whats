// Reads the customer list for a marketing campaign from an .xlsx or .csv file
// into the rows the campaign preflight screens. Nothing is validated here
// beyond the file's shape: phone, consent and parameter rules live in
// preflight.ts, so a bad row is reported there with its reason, not dropped.
//
// Columns (first row is the header, order does not matter):
//   phone         the customer's number (any Saudi spelling)
//   consent_date  when they registered / agreed, ideally a real Excel date or YYYY-MM-DD
//   var1, var2…   values for the template's {{1}}, {{2}}… (contiguous from var1)

import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import type { RecipientRow } from "./preflight";

export class RecipientsFileError extends Error {}

export type ParsedRow = RecipientRow & {
  /** Row number in the spreadsheet (header is row 1), to point at it in reports. */
  sourceRow: number;
};

export type ParsedRecipients = {
  rows: ParsedRow[];
  /** Number of varN columns found, to compare with the template's variable count. */
  paramCount: number;
  warnings: string[];
};

export type ParseOptions = {
  /** Recorded as every row's consent source. Default "dashboard". */
  consentSource?: string;
  maxRows?: number;
  maxBytes?: number;
};

// A campaign's recipients and outcomes are each saved as one Redis value; 2,000 rows keep both well under
// Upstash's 1 MB request limit. Larger lists go in as several campaigns, one after the other.
const DEFAULT_MAX_ROWS = 2_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const PHONE_HEADERS = new Set(["phone", "mobile", "phone_number", "الجوال", "رقم_الجوال", "الهاتف", "رقم_الهاتف"]);
const CONSENT_HEADERS = new Set(["consent_date", "consent_at", "registered_at", "signup_date", "تاريخ_التسجيل", "تاريخ_الموافقة"]);

const headerKey = (s: unknown) =>
  String(s ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** A cell's value as a plain string, number or Date; formulas give their result, rich text its text. */
function plain(v: ExcelJS.CellValue): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return String(v);
  if ("result" in v) return plain(v.result as ExcelJS.CellValue);
  if ("richText" in v) return v.richText.map((t) => t.text).join("");
  if ("text" in v) return String(v.text);
  return null; // error cells such as #N/A
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function textOf(v: ExcelJS.CellValue): string {
  const p = plain(v);
  if (p === null) return "";
  if (p instanceof Date) return isoDay(p);
  return String(p).trim();
}

/** Dates arrive as Date (a date-formatted cell), an ISO string, or a bare Excel serial number. */
function consentOf(v: ExcelJS.CellValue): Date | string | undefined {
  const p = plain(v);
  if (p === null) return undefined;
  if (p instanceof Date) return p;
  if (typeof p === "number" && p >= 20_000 && p <= 80_000) return new Date(Math.round((p - 25_569) * 86_400_000)); // Excel serial, 1900 system
  const s = String(p).trim();
  return s === "" ? undefined : s;
}

async function load(data: Uint8Array, filename: string): Promise<ExcelJS.Worksheet[]> {
  const wb = new ExcelJS.Workbook();
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    await wb.xlsx.load(Buffer.from(data) as unknown as ExcelJS.Buffer);
    return wb.worksheets;
  }
  if (lower.endsWith(".csv")) {
    let bytes = Buffer.from(data);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // UTF-8 BOM from Excel
    const firstLine = bytes.toString("utf8").split(/\r?\n/, 1)[0];
    const delimiter = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ","; // Arabic-locale Excel exports ";"
    // Keep every cell a string: the default turns "0501234567" into a number and "007" into 7.
    const ws = await wb.csv.read(Readable.from(bytes), { dateFormats: [], map: (value: string) => value, parserOptions: { delimiter } });
    return [ws];
  }
  throw new RecipientsFileError("Unsupported file type: use .xlsx or .csv (an old .xls must be saved as .xlsx first).");
}

export async function parseRecipientsFile(data: Uint8Array, filename: string, opts: ParseOptions = {}): Promise<ParsedRecipients> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (data.byteLength > maxBytes) throw new RecipientsFileError(`File is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);

  let sheets: ExcelJS.Worksheet[];
  try {
    sheets = await load(data, filename);
  } catch (e) {
    if (e instanceof RecipientsFileError) throw e;
    throw new RecipientsFileError(`Could not read the file; is it a valid ${filename.toLowerCase().endsWith(".csv") ? "CSV" : "Excel"} file? (${(e as Error).message})`);
  }
  const ws = sheets[0];
  if (!ws || ws.rowCount < 1) throw new RecipientsFileError("The file is empty.");
  const warnings: string[] = [];
  if (sheets.length > 1) warnings.push(`The workbook has ${sheets.length} sheets; only the first ("${ws.name}") was read.`);

  // header row
  let phoneCol = 0;
  let consentCol = 0;
  const varCols = new Map<number, number>(); // n of varN -> column
  const seen: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = headerKey(textOf(cell.value));
    seen.push(key);
    if (PHONE_HEADERS.has(key)) phoneCol ||= col;
    else if (CONSENT_HEADERS.has(key)) consentCol ||= col;
    else if (/^var\d+$/.test(key)) varCols.set(Number(key.slice(3)), col);
  });
  const missing = [!phoneCol && "phone", !consentCol && "consent_date"].filter(Boolean);
  if (missing.length) throw new RecipientsFileError(`Missing column(s): ${missing.join(", ")}. Found: ${seen.filter(Boolean).join(", ") || "none"}.`);

  const paramCount = varCols.size;
  for (let n = 1; n <= paramCount; n++) {
    if (!varCols.has(n)) {
      const found = [...varCols.keys()].sort((a, b) => a - b).map((k) => `var${k}`);
      throw new RecipientsFileError(`Variable columns must be var1, var2, … without gaps; found ${found.join(", ")}.`);
    }
  }

  // data rows
  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const phone = plain(row.getCell(phoneCol).value);
    const consentAt = consentOf(row.getCell(consentCol).value);
    const params = Array.from({ length: paramCount }, (_, i) => textOf(row.getCell(varCols.get(i + 1)!).value));
    if (phone === null && consentAt === undefined && params.every((p) => p === "")) continue; // blank row
    if (rows.length >= maxRows) throw new RecipientsFileError(`More than ${maxRows} rows; split the file into smaller ones.`);
    rows.push({
      phone: phone instanceof Date ? isoDay(phone) : phone,
      consentSource: opts.consentSource ?? "dashboard",
      consentAt,
      params,
      sourceRow: r,
    });
  }
  if (rows.length === 0) throw new RecipientsFileError("The file has a header but no customer rows.");

  return { rows, paramCount, warnings };
}
