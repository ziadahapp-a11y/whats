// One automatic app-rating message per merchant on the official number: sent between 20 and 23.5 hours after the
// merchant's last message, so it still lands inside the 24-hour window. Only for a subscribed merchant whose exchange
// ended with an answer from Zaid, with no team member in the chat and nothing open (a question to the merchant,
// a handoff, a complaint, a meeting still ahead). The platform comes from the merchant's record; an unknown platform sends nothing.

import type { RawKV } from "../wa/auth";
import type { Conversation, Store } from "../store";
import type { Merchant } from "../merchants";
import type { Channel } from "./engine";
import { isAppAuto } from "./links";

export const ZID_LINK = "https://apps.zid.sa/application/1826";
export const SALLA_LINK = "https://apps.salla.sa/ar/app/1099604538";
export const RATING_AFTER = 20 * 3600;
const LATEST = 23.5 * 3600;

export const ratingText = (platform: "zid" | "salla") =>
  `تقييمك يصنع الفرق قيمنا الحين من صفحة التطبيق في ${platform === "zid" ? "زد" : "سلة"} بالرابط التالي: {{للتقييم من هنا|${platform === "zid" ? ZID_LINK : SALLA_LINK}}}`;

/** zid or salla for a subscribed merchant, otherwise undefined. */
export function ratingPlatform(list: readonly Merchant[]): "zid" | "salla" | undefined {
  const active = list.filter((m) => m.status === "paid" || m.status === "trial");
  const kinds = new Set(active.map((m) => (/zid|زد/i.test(m.platform ?? "") ? "zid" : /salla|سلة/i.test(m.platform ?? "") ? "salla" : "")).filter(Boolean));
  return kinds.size === 1 ? ([...kinds][0] as "zid" | "salla") : undefined;
}

/** Our last words leave something open: a handoff, an opt-out, a wait for the merchant. */
const OPEN = /جاري تحويلك|تم إيقاف الرسائل|ننتظر ردك|جاري متابعة الإشكالية|بيراجع الفريق|ابدأ|اختر الوقت|أرسل لي/;
/** The merchant is upset, cancelling, asking for money back, or opting out. */
const UPSET = /الغاء|إلغاء|الغي|استرجاع|استرداد|فاتورة|زعلان|سيء|سيئ|ما ?[يت]?شتغل|مشكل|خطأ|ايقاف|إيقاف|شكوى|احتيال|نصب/;
/** A store's own bot answering, not the merchant. */
const BOT = /أهلاً بك في|اهلا بك في|شكرا لتواصلك|شكراً لتواصلك|يرجى إخبارنا|كيف أقدر أساعدك اليوم/;

export async function sendRatings(
  d: { store: Store; state: RawKV; channel: Channel; merchantsOf: (chat: string) => Promise<Merchant[]>; hasMeeting?: (chat: string, name?: string) => Promise<boolean>; convs?: Conversation[] },
  now = Math.floor(Date.now() / 1000),
  scan = 200,
): Promise<string[]> {
  const convs = d.convs ?? (await d.store.conversations(scan, undefined, now));
  const due = convs.filter((c) => {
    const age = c.lastInboundAt ? now - c.lastInboundAt : -1;
    return age >= RATING_AFTER && age < LATEST && c.last?.direction === "out" && c.last.source !== "business_app";
  });
  if (!due.length) return [];
  const out = await d.store.optedOut(due.map((c) => c.waId));
  const sent: string[] = [];
  for (const c of due) {
    if (out.has(c.waId)) continue;
    const last = (c.last?.text ?? "").trim();
    if (!last || OPEN.test(last) || /[؟?]$/.test(last)) continue;
    const msgs = await d.store.messages(c.waId, 40);
    if (msgs.some((m) => m.direction === "out" && m.source === "business_app" && !isAppAuto(m) && now - m.timestamp < 24 * 3600)) continue;
    const said = msgs.map((m) => m.text ?? m.caption ?? "");
    if (said.some((t) => t.includes("apps/1826") || t.includes("application/1826") || t.includes("1099604538"))) continue;
    const mine = msgs.filter((m) => m.direction === "in" && m.type !== "reaction").slice(-6).map((m) => m.text ?? m.caption ?? "");
    if (mine.some((t) => UPSET.test(t) || BOT.test(t))) continue;
    // a meeting still ahead means the exchange is not over
    if (await d.hasMeeting?.(c.waId, c.name).catch(() => true)) continue;
    const platform = ratingPlatform(await d.merchantsOf(c.waId).catch(() => []));
    if (!platform) continue;
    // once per merchant, ever
    if (!(await d.state.set(`rated:${c.waId}`, "1", { ex: 365 * 86400, nx: true }))) continue;
    try {
      await d.channel.sendText(c.waId, ratingText(platform));
      sent.push(c.waId);
    } catch (e) {
      console.error("rating message failed", c.waId, e);
    }
  }
  return sent;
}
