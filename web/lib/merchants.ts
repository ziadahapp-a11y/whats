// Who is writing: Zaid looks the merchant's number up in the "CRM حالة التجار" Google Sheet, which the
// store-recovery dashboard refreshes daily, and gets the store, platform, plan, end date and status.
// The sheet is read with the Google account connected for the calendar, and kept in Redis for 30 minutes.

import type { RawKV } from "./wa/auth";
import { Calendar } from "./gcal";

const DEFAULT_SHEET = "16xf2YUmBiNRIVGDdArZXhpo33xY7jXGlkp6eivPkvYU";
/** Ziadah's own tabs: Zaid supports Ziadah only */
const TABS = ["زيادة زد", "زيادة سلة"];
const CACHE = "meta:crm:index";
const FRESH_SECS = 30 * 60;
/** a failed read (Google not connected, scope missing) is not retried on every message */
const RETRY_SECS = 10 * 60;

export type Merchant = { store: string; platform?: string; plan?: string; end?: string; status?: string };
type Index = Record<string, Merchant[]>;

const STATUS_AR: Record<string, string> = { paid: "مشترك (مدفوع)", trial: "فترة تجربة", inactive: "مثبّت بدون اشتراك فعّال", lost: "الاشتراك منتهي أو موقوف" };

/** phone digits as WhatsApp ids carry them: 9665XXXXXXXX */
export function normPhone(raw: string): string | null {
  let d = raw.replace(/[^\d]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = "966" + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = "966" + d;
  return d.length >= 9 && d.length <= 15 ? d : null;
}

/** Builds phone -> merchants from the sheet tabs ({values} as Sheets returns them, header row first). */
export function buildIndex(tabs: { values?: string[][] }[]): Index {
  const index: Index = {};
  for (const t of tabs) {
    const [head, ...rows] = t.values ?? [];
    if (!head) continue;
    const col = (name: string) => head.findIndex((h) => String(h).trim().toLowerCase() === name.toLowerCase());
    const c = { name: col("Store Name"), phone: col("Phone"), extra: col("Extra Phones"), plat: col("Platform"), plan: col("Plan"), end: col("End Date"), st: col("Subscription Status") };
    if (c.name < 0 || c.phone < 0) continue;
    for (const r of rows) {
      const cell = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
      const store = cell(c.name);
      if (!store) continue;
      const m: Merchant = { store, platform: cell(c.plat) || undefined, plan: cell(c.plan) || undefined, end: cell(c.end) || undefined, status: cell(c.st) || undefined };
      const phones = `${cell(c.phone)} ${cell(c.extra)}`.split(/[\/,،;\s]+/).map(normPhone).filter((p): p is string => !!p);
      for (const p of new Set(phones)) (index[p] ??= []).push(m);
    }
  }
  return index;
}

async function loadIndex(base: RawKV, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<Index> {
  const cached = await base.get(CACHE);
  if (cached) return JSON.parse(cached) as Index;
  try {
    const token = await new Calendar(base, env, fetchImpl).accessToken();
    const sheet = env.CRM_SHEET_ID || DEFAULT_SHEET;
    const q = TABS.map((t) => `ranges=${encodeURIComponent(`'${t}'!A:W`)}`).join("&");
    const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values:batchGet?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${data?.error?.message ?? res.statusText}`);
    const index = buildIndex(data.valueRanges ?? []);
    await base.set(CACHE, JSON.stringify(index), { ex: FRESH_SECS });
    return index;
  } catch (e) {
    console.error("merchants sheet", e instanceof Error ? e.message : e);
    await base.set(CACHE, "{}", { ex: RETRY_SECS });
    return {};
  }
}

export async function findMerchant(base: RawKV, chat: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<Merchant[]> {
  const phone = normPhone(chat.split("@")[0]);
  if (!phone) return [];
  return (await loadIndex(base, env, fetchImpl))[phone] ?? [];
}

export const MERCHANT_RULE = `<merchant> is what our records say about the merchant writing to you, matched by their phone number. Use it to answer questions about their own store, plan and dates without asking them again (for example, a price question is about their current plan unless they name another). Never share an email or another phone number, never mention records, a sheet or a system, and do not bring up an ended or stopped subscription unless they ask about it. When they ask about their plan or what it includes, name their plan from <merchant> (for example: باقتك النمو السنوية) and answer for that plan only; do not describe other plans' limits as if they were theirs. When <merchant> lists their store, never ask them for the store name, and never ask for an email just to identify them. If several stores are listed, ask which one they mean only when the answer depends on it. Never guess a store or plan that is not listed.`;

/** The system-prompt block for this chat, or "" when the number is not in the sheet. */
export function merchantContext(list: Merchant[]): string {
  if (!list.length) return "";
  const lines = list.slice(0, 5).map((m) => `- ${[`المتجر: ${m.store}`, m.platform && `المنصة: ${m.platform}`, m.plan && `الباقة: ${m.plan}`, m.end && `ينتهي الاشتراك: ${m.end}`, m.status && `الحالة: ${STATUS_AR[m.status] ?? m.status}`].filter(Boolean).join("، ")}`);
  return `${MERCHANT_RULE}\n\n<merchant>\n${lines.join("\n")}\n</merchant>`;
}
