// Meetings on the official number: Zaid offers free times from Google Calendar, books the one the
// merchant picks (marker [[BOOK <local time> <email>]] in its reply), and reminds them on the day.

import type { RawKV } from "../wa/auth";
import type { Store } from "../store";
import type { Channel } from "./engine";
import { Calendar, connection, freeSlots, getSettings, localDay, localIso, atLocal, slotLabel, spread, timeLabel, type Settings } from "../gcal";

export const HANDOFF = "جاري تحويلك للفريق المختص\n\nان لم تتلقى رد خلال 24 ساعة، فضلاً عاود الإرسال فذلك بسبب كثرة الرسائل أو اجازة الأسبوع";
const MARKER = /\[\[\s*BOOK\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+([^\s\]]+)\s*\]\]/i;
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

export type Meetings = {
  /** extra system text with the free times, or "" when the calendar is not connected */
  context(): Promise<string>;
  /** books when the reply carries a marker and returns the text to send */
  apply(reply: string, chat: string, name?: string): Promise<string>;
};

async function free(cal: Calendar, s: Settings, now: number) {
  const busy = await cal.busy(now, now + (s.aheadDays + 1) * 86400000);
  return freeSlots(s, busy, now, 60);
}

export function meetings(base: RawKV, now: () => number = Date.now, cal = new Calendar(base)): Meetings {
  return {
    async context() {
      if (!(await connection(base)).connected) return "";
      const s = await getSettings(base);
      let offer: number[];
      try {
        offer = spread(await free(cal, s, now()), s.tz);
      } catch (e) {
        console.error("calendar read failed", e);
        return "";
      }
      const list = offer.length ? offer.map((t) => `- ${slotLabel(t, s.tz)} [${localIso(t, s.tz)}]`).join("\n") : "(no free times right now)";
      return `Meetings: you can book a ${s.minutes}-minute online meeting (Google Meet) yourself. This replaces handing meeting requests to the team.
- Offer the merchant two or three of the free times below, using the Arabic label only. Never offer or accept any other time.
- To send the calendar invite you need the merchant's email; ask for it if it is not in the conversation.
- Only when the merchant has clearly chosen one of these times and given an email, write a short confirmation and end the reply with exactly [[BOOK <time in brackets> <email>]], for example [[BOOK ${offer[0] ? localIso(offer[0], s.tz) : "2026-11-02T10:30"} name@example.com]]. The system books it and adds the meeting link.
- If none of the times suits them or no free times are listed, hand over to the team as usual.
Free times (${s.tz}):
${list}`;
    },

    async apply(reply, chat, name) {
      const m = MARKER.exec(reply);
      if (!m) return reply;
      const text = reply.replace(MARKER, "").trim();
      const [, when, email] = m;
      try {
        if (!EMAIL.test(email)) throw new Error(`bad email ${email}`);
        const s = await getSettings(base);
        const slot = (await free(cal, s, now())).find((t) => localIso(t, s.tz) === when);
        if (slot === undefined) throw new Error(`${when} is not free any more`);
        const ev = await cal.book({ start: slot, end: slot + s.minutes * 60000, title: s.title, email, chat, name, tz: s.tz });
        return `${text}\n\nموعدنا ${slotLabel(slot, s.tz)}، ووصلتك دعوة على ${email}.${ev.meet ? `\nرابط الاجتماع: ${ev.meet}` : ""}`.trim();
      } catch (e) {
        console.error("meeting booking failed", chat, e);
        return `ما قدرت أثبت الموعد تلقائياً، والفريق بيأكده لك.\n\n${HANDOFF}`;
      }
    },
  };
}

/**
 * On the meeting day (from 8 in the morning, until 30 minutes before it), one reminder per meeting Zaid booked,
 * only while the merchant's 24-hour window is open.
 */
export async function sendMeetingReminders(d: { base: RawKV; store: Store; state: RawKV; channel: Channel }, now = Date.now(), cal = new Calendar(d.base)): Promise<string[]> {
  if (!(await connection(d.base)).connected) return [];
  const s = await getSettings(d.base);
  const today = localDay(now, s.tz);
  const morning = atLocal(today.y, today.m, today.d, "08:00", s.tz);
  if (now < morning) return [];
  const endOfDay = atLocal(today.y, today.m, today.d, "23:59", s.tz);
  const sent: string[] = [];
  for (const ev of await cal.booked(now + 30 * 60000, endOfDay)) {
    if (!ev.chat) continue;
    if (!(await d.store.window(ev.chat, Math.floor(now / 1000))).windowOpen) continue;
    if (!(await d.state.set(`mr:${ev.id}`, "1", { ex: 3 * 86400, nx: true }))) continue;
    try {
      await d.channel.sendText(ev.chat, `حياك الله للتذكير\nموعدنا اليوم بإذن الله الساعة ${timeLabel(ev.start, s.tz)}${ev.meet ? `\nرابط الاجتماع: ${ev.meet}` : ""}`);
      sent.push(ev.chat);
    } catch (e) {
      console.error("meeting reminder failed", ev.chat, e);
    }
  }
  return sent;
}
