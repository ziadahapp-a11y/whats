// Meetings on the official number: Zaid offers free times from Google Calendar, books the one the
// merchant picks (marker [[BOOK <local time> <email>]] in its reply), and reminds them on the day.

import type { RawKV } from "../wa/auth";
import type { Store } from "../store";
import type { Channel } from "./engine";
import { Calendar, connection, type CalEvent, freeSlots, getSettings, localIso, slotLabel, spread, timeLabel, type Settings } from "../gcal";

export const HANDOFF = "جاري تحويلك للفريق المختص\n\nان لم تتلقى رد خلال 24 ساعة، فضلاً عاود الإرسال فذلك بسبب كثرة الرسائل أو اجازة الأسبوع";
const MARKER = /\[\[\s*BOOK\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+([^\s\]]+)\s*\]\]/i;
const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

export type Meetings = {
  /** extra system text with the free times (or the merchant's meeting already booked), or "" when the calendar is not connected */
  context(chat?: string, name?: string): Promise<string>;
  /** books when the reply carries a marker and returns the text to send */
  apply(reply: string, chat: string, name?: string): Promise<string>;
};

async function free(cal: Calendar, s: Settings, now: number) {
  const busy = await cal.busy(now, now + (s.aheadDays + 1) * 86400000);
  return freeSlots(s, busy, now, 60);
}

export function meetings(base: RawKV, store?: Store, now: () => number = Date.now, cal = new Calendar(base)): Meetings {
  // the merchant's next meeting, so Zaid never books a second one
  const booked = async (s: Settings, chat?: string, name?: string, email?: string) => {
    if (!chat || !store) return undefined;
    try {
      const t = now();
      const evs = (await cal.events(t - 3 * 3600000, t + (s.aheadDays + 1) * 86400000)).filter((e) => e.end > t);
      return await existingFor(evs, store, chat, name, email);
    } catch (e) {
      console.error("calendar read failed", e);
      return undefined;
    }
  };
  return {
    async context(chat, name) {
      if (!(await connection(base)).connected) return "";
      const s = await getSettings(base);
      const ev = await booked(s, chat, name);
      if (ev) {
        const link = ev.meet ? ` The meeting link is ${ev.meet}; write it as [دخول الاجتماع](${ev.meet}).` : " There is no meeting link yet; say the team will send it before the meeting.";
        return `Meetings: this merchant already has a meeting booked ${slotLabel(ev.start, s.tz)} (${s.tz}).${link}
- Do not book another meeting, do not offer other times and never output [[BOOK]].
- If they ask for a meeting or about it, tell them this time.
- If they want to move or cancel it, hand over to the team as usual.`;
      }
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
        const had = await booked(s, chat, name, email);
        if (had) return `موعدنا محجوز لك من قبل ${slotLabel(had.start, s.tz)} بإذن الله${had.meet ? meetLine(had) : "، والفريق بيرسل لك رابط الاجتماع قبل الموعد"}`;
        const slot = (await free(cal, s, now())).find((t) => localIso(t, s.tz) === when);
        if (slot === undefined) throw new Error(`${when} is not free any more`);
        const ev = await cal.book({ start: slot, end: slot + s.minutes * 60000, title: s.title, email, chat, name, tz: s.tz });
        // the system's confirmation replaces Zaid's own wording, so the merchant reads it once
        return `تم حجز موعدنا ${slotLabel(slot, s.tz)} بإذن الله، ووصلتك دعوة على ${email}.${meetLine(ev)}`;
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

// words that say nothing about which store a meeting is for
const GENERIC = new Set(["اجتماع", "متابعه", "زياده", "متجر", "مؤسسه", "شركه", "موعد", "عرض", "تطبيق", "meeting", "store", "ziadah", "call"]);
const norm = (s: string) => s.toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[\u064B-\u0652\u0640]/g, "");
const words = (s: string) =>
  new Set(norm(s).split(/[^\p{L}\p{N}]+/u).map((w) => w.replace(/^(ال|لل)(?=\p{L}{3})/u, "")).filter((w) => w.length >= 4 && !GENERIC.has(w)));

/**
 * The merchant's upcoming meeting, if any: Zaid's tag, their phone or one of their emails in the event, or,
 * for a meeting the team added by hand, a distinctive word of the chat name (the store name) in its title.
 */
export async function existingFor(evs: CalEvent[], store: Store, chat: string, name?: string, email?: string): Promise<CalEvent | undefined> {
  const mine = new Set<string>(email ? [email.toLowerCase()] : []);
  for (const m of await store.messages(chat, 60)) if (m.direction === "in") for (const e of `${m.text ?? ""}`.match(EMAILS) ?? []) mine.add(e.toLowerCase());
  const named = words(name ?? "");
  return evs.find(
    (ev) =>
      ev.chat === chat ||
      phonesIn(`${ev.text ?? ""}\n${ev.summary ?? ""}`).includes(chat) ||
      (ev.emails ?? []).some((e) => mine.has(e)) ||
      (!ev.chat && !ev.emails?.length && [...words(ev.summary ?? "")].some((w) => named.has(w))),
  );
}

/**
 * Meetings in the calendar that belong to a WhatsApp chat (booked by Zaid, from the booking page or by the team):
 * - a confirmation for one booked in the last two days that Zaid did not book itself (Zaid confirms in its reply);
 * - one reminder REMIND_MINUTES before it starts (sent at the first wake-up inside that window).
 * Both only while the merchant's 24-hour window is open.
 */
type Deps = { base: RawKV; store: Store; state: RawKV; channel: Channel };
// shown as a "دخول الاجتماع" button on the official number
const meetLine = (ev: CalEvent) => (ev.meet ? `\n[دخول الاجتماع](${ev.meet})` : "");
export const REMIND_MINUTES = 45;

export async function sendMeetingReminders(d: Deps, now = Date.now(), cal = new Calendar(d.base)): Promise<string[]> {
  if (!(await connection(d.base)).connected) return [];
  const s = await getSettings(d.base);
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
  for (const ev of await cal.events(now + 5 * 60000, now + (s.aheadDays + 1) * 86400000)) {
    const fresh = !ev.chat && !!ev.created && now - ev.created < 2 * 86400000;
    const due = ev.start - now <= REMIND_MINUTES * 60000;
    if (!fresh && !due) continue;
    const chat = await match.chatFor(ev);
    if (!chat || !(await d.store.window(chat, Math.floor(now / 1000))).windowOpen) continue;
    if (fresh && (await d.state.set(`mc:${ev.id}`, "1", { ex: 30 * 86400, nx: true }))) {
      // a confirmation this close to the start already says when; no separate reminder after it
      if (due) await d.state.set(`mr:${ev.id}`, "1", { ex: 3 * 86400 });
      await send(chat, `حياك الله، تم تأكيد موعدنا ${slotLabel(ev.start, s.tz)} بإذن الله${meetLine(ev)}`);
      continue;
    }
    if (due && (await d.state.set(`mr:${ev.id}`, "1", { ex: 3 * 86400, nx: true }))) {
      await send(chat, `حياك الله للتذكير\nموعدنا اليوم بإذن الله الساعة ${timeLabel(ev.start, s.tz)}${meetLine(ev)}`);
    }
  }
  return sent;
}
