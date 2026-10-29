// Meetings on the official number: Zaid offers free times from Google Calendar, books the one the
// merchant picks (marker [[BOOK <local time> <email>]] in its reply), and reminds them on the day.

import type { RawKV } from "../wa/auth";
import type { Store } from "../store";
import type { Channel } from "./engine";
import { Calendar, connection, type CalEvent, freeSlots, getSettings, localDay, localIso, atLocal, slotLabel, spread, timeLabel, type Settings } from "../gcal";

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

const EMAILS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Saudi mobiles as booking forms write them: +966 5x, 00966 5x, 05x
const PHONES = /(?:\+|00)?966[\s-]?5[\d\s-]{8,12}|\b05[\d\s-]{8,11}/g;

function phonesIn(text: string): string[] {
  return (text.match(PHONES) ?? []).map((p) => {
    const d = p.replace(/\D/g, "").replace(/^00/, "");
    return d.startsWith("05") ? `966${d.slice(1)}` : d;
  }).filter((d) => /^9665\d{8}$/.test(d));
}

/** The WhatsApp chat a calendar event belongs to: Zaid's own tag, a phone in the booking details, or a guest email the merchant wrote in a chat. */
export class ChatMatcher {
  private emails?: Map<string, string>;
  constructor(private store: Store, private scan = 100) {}

  private async emailIndex() {
    if (this.emails) return this.emails;
    const map = new Map<string, string>();
    for (const c of await this.store.conversations(this.scan)) {
      for (const m of await this.store.messages(c.waId, 60)) {
        if (m.direction !== "in") continue;
        for (const e of `${m.text ?? ""}`.match(EMAILS) ?? []) if (!map.has(e.toLowerCase())) map.set(e.toLowerCase(), c.waId);
      }
    }
    return (this.emails = map);
  }

  async chatFor(ev: CalEvent): Promise<string | undefined> {
    if (ev.chat) return ev.chat;
    for (const p of phonesIn(`${ev.text ?? ""}\n${ev.summary ?? ""}`)) if ((await this.store.messages(p, 1)).length) return p;
    if (!ev.emails?.length) return undefined;
    const idx = await this.emailIndex();
    for (const e of ev.emails) if (idx.has(e)) return idx.get(e);
    return undefined;
  }
}

type Deps = { base: RawKV; store: Store; state: RawKV; channel: Channel };
const meetLine = (ev: CalEvent) => (ev.meet ? `\nرابط الاجتماع: ${ev.meet}` : "");

/**
 * Meetings in the calendar that belong to a WhatsApp chat (booked by Zaid, from the booking page or by the team):
 * - a confirmation for one booked in the last two days that Zaid did not book itself (Zaid confirms in its reply);
 * - on the meeting day, from 8 in the morning until 30 minutes before it, one reminder.
 * Both only while the merchant's 24-hour window is open.
 */
export async function sendMeetingReminders(d: Deps, now = Date.now(), cal = new Calendar(d.base)): Promise<string[]> {
  if (!(await connection(d.base)).connected) return [];
  const s = await getSettings(d.base);
  const today = localDay(now, s.tz);
  const morning = atLocal(today.y, today.m, today.d, "08:00", s.tz);
  const endOfDay = atLocal(today.y, today.m, today.d, "23:59", s.tz);
  const match = new ChatMatcher(d.store);
  const sent: string[] = [];
  const send = async (chat: string, text: string) => {
    try {
      await d.channel.sendText(chat, text);
      sent.push(chat);
      return true;
    } catch (e) {
      console.error("meeting message failed", chat, e);
      return false;
    }
  };
  for (const ev of await cal.events(now + 30 * 60000, now + (s.aheadDays + 1) * 86400000)) {
    const fresh = !ev.chat && !!ev.created && now - ev.created < 2 * 86400000;
    const isToday = ev.start <= endOfDay && now >= morning;
    if (!fresh && !isToday) continue;
    const chat = await match.chatFor(ev);
    if (!chat || !(await d.store.window(chat, Math.floor(now / 1000))).windowOpen) continue;
    if (fresh && (await d.state.set(`mc:${ev.id}`, "1", { ex: 30 * 86400, nx: true }))) {
      // a same-day confirmation already says when; no separate reminder after it
      if (isToday) await d.state.set(`mr:${ev.id}`, "1", { ex: 3 * 86400 });
      await send(chat, `حياك الله، تم تأكيد موعدنا ${slotLabel(ev.start, s.tz)} بإذن الله${meetLine(ev)}`);
      continue;
    }
    if (isToday && (await d.state.set(`mr:${ev.id}`, "1", { ex: 3 * 86400, nx: true }))) {
      await send(chat, `حياك الله للتذكير\nموعدنا اليوم بإذن الله الساعة ${timeLabel(ev.start, s.tz)}${meetLine(ev)}`);
    }
  }
  return sent;
}
