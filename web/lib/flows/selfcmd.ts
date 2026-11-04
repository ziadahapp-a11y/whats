// Commands the team writes to Zaid in the official number's chat with itself (the Business app echoes it):
//   احجز اجتماع سما فارما الساعه 3 bashair@samapharma.com [0551234567] [بكرا]
// Zaid books the meeting straight away (Google Meet, invite emailed to the guest) and, when it knows the
// merchant's WhatsApp number and their 24-hour window is open, sends them the summary with the link.

import type { RawKV } from "../wa/auth";
import type { Store, StoredMessage } from "../store";
import type { Channel } from "./engine";
import { atLocal, Calendar, connection, getSettings, localDay, slotLabel, type Settings } from "../gcal";
import { ChatMatcher, phonesIn, siteUrl } from "./meetings";
import { phoneForStore } from "../merchants";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URLS = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;
const DAYS: [RegExp, number][] = [
  [/الاحد|الأحد/, 0],
  [/الاثنين|الإثنين|الاتنين/, 1],
  [/الثلاثاء|الثلاثا/, 2],
  [/الاربعاء|الأربعاء|الاربعا/, 3],
  [/الخميس/, 4],
  [/الجمعة|الجمعه/, 5],
  [/السبت/, 6],
];
const DIGITS = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
// words that end the store name in the command
const NAME_END = /\s(?:الساع[هة]|ساع[هة]|اليوم|بكر[اةه]|غدا|غداً|بعد|يوم|الاحد|الأحد|الاثنين|الإثنين|الثلاثاء|الاربعاء|الأربعاء|الخميس|الجمعة|الجمعه|السبت|الصبح|العصر|الظهر|المغرب|\d)/;

export type BookCommand = { start: number; email: string; phone?: string; name?: string; store?: string };

/** Reads an "احجز ..." command. Returns the booking, an Arabic reason it cannot, or null when the text is no command. */
export function parseBook(raw: string, now: number, s: Pick<Settings, "tz">): BookCommand | string | null {
  const text = DIGITS(raw).replace(/\s+/g, " ").trim();
  if (!/^احجز/.test(text)) return null;
  const email = text.match(EMAIL)?.[0];
  if (!email) return "ما لقيت إيميل التاجر في الأمر";
  const phone = phonesIn(text)[0];
  const store = (text.replace(EMAIL, " ").match(URLS) ?? []).map((u) => siteUrl(u)).find(Boolean);

  // the time: everything else is removed first so a phone or an email never reads as an hour
  let rest = ` ${text} `.replace(EMAIL, " ").replace(URLS, " ").replace(/(?:\+|00)?966[\s-]?5[\d\s-]{8,12}|\b05[\d\s-]{8,11}/g, " ");
  const today = localDay(now, s.tz);
  let day: { y: number; m: number; d: number } | undefined;
  const date = rest.match(/\b(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?\b/);
  if (date) {
    const y = date[3] ? (date[3].length === 2 ? 2000 + Number(date[3]) : Number(date[3])) : today.y;
    day = { y, m: Number(date[2]), d: Number(date[1]) };
    rest = rest.replace(date[0], " ");
  }
  const shift = (n: number) => localDay(now + n * 86400000, s.tz);
  if (!day && /بعد\s*(?:بكر[اةه]|غد)/.test(rest)) day = shift(2);
  else if (!day && /بكر[اةه]|غدا|غداً|الغد/.test(rest)) day = shift(1);
  if (!day) for (const [re, wd] of DAYS) if (re.test(rest)) day = shift((wd - today.weekday + 7) % 7);
  const dated = !!day;
  day ??= today;

  const t = rest.match(/(?:الساع[هة]|ساع[هة])?\s*\b(\d{1,2})(?:[:.](\d{2}))?\b\s*(ونص|و نص|وربع|و ربع|الا ربع|إلا ربع)?\s*(صباحاً|صباحا|الصبح|ص(?=\s|$)|am\b|مساءً|مساء|العصر|الظهر|المغرب|الليل|م(?=\s|$)|pm\b)?/i);
  if (!t) return "ما لقيت وقت الاجتماع في الأمر";
  let h = Number(t[1]);
  let mi = t[2] ? Number(t[2]) : 0;
  if (t[3]) mi = /نص/.test(t[3]) ? 30 : /الا|إلا/.test(t[3]) ? -15 : 15;
  const mark = t[4] ?? "";
  if (/صباح|الصبح|^ص$|am/i.test(mark)) h = h === 12 ? 0 : h;
  else if (mark || h < 9) h = h < 12 ? h + 12 : h; // a bare 1 to 8 is the afternoon: meetings run 10:00 to 16:30
  if (mi < 0) { h -= 1; mi = 45; }
  if (h > 23 || mi > 59) return "وقت الاجتماع غير واضح";
  const start = atLocal(day.y, day.m, day.d, `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, s.tz);
  if (start < now) return dated ? "وقت الاجتماع فات" : "الوقت فات اليوم، اكتب اليوم المطلوب (بكرا أو اسم اليوم أو التاريخ)";

  // the store name: what follows احجز (and اجتماع/موعد) up to the time, the day or a number
  const after = ` ${text.replace(EMAIL, " ").replace(URLS, " ")} `.replace(/^\s*احجز\s*(?:لي\s*)?(?:اجتماع|موعد|ميتنق|ميتينق)?\s*(?:مع|ل|لـ)?\s*/, " ");
  const name = after.split(NAME_END)[0].replace(/[،,.:؟?]+/g, " ").trim() || undefined;
  return { start, email, phone, name, store };
}

type Deps = { base: RawKV; store: Store; state: RawKV; channel: Channel; cal?: Calendar; now?: number };

/** Runs the commands found in self-chat echoes; returns one log line per command. */
export async function runSelfCommands(msgs: StoredMessage[], d: Deps): Promise<string[]> {
  const logs: string[] = [];
  for (const m of msgs) {
    if (m.type !== "text" || !m.text) continue;
    const now = d.now ?? Date.now();
    if (!/^\s*احجز/.test(m.text)) continue;
    if (!(await d.state.set(`self:${m.id}`, "1", { ex: 7 * 86400, nx: true }))) continue; // Meta redelivers
    try {
      if (!(await connection(d.base)).connected) throw new Error("Google Calendar is not connected");
      const s = await getSettings(d.base);
      const cmd = parseBook(m.text, now, s);
      if (!cmd) continue;
      if (typeof cmd === "string") throw new Error(cmd);
      const phone = cmd.phone ?? (await findChat(d, cmd));
      const cal = d.cal ?? new Calendar(d.base);
      const ev = await cal.book({ start: cmd.start, end: cmd.start + s.minutes * 60000, title: s.title, email: cmd.email, chat: phone ?? "", name: cmd.name, tz: s.tz, store: cmd.store, note: "حجزه الفريق من محادثة زيد." });
      let told = "no WhatsApp number found";
      if (phone) {
        if ((await d.store.window(phone, Math.floor(now / 1000))).windowOpen) {
          await d.channel.sendText(phone, `حياك الله، تم حجز موعدنا ${slotLabel(cmd.start, s.tz)} بإذن الله، ووصلتك دعوة على ${cmd.email}.${ev.meet ? `\n[دخول الاجتماع](${ev.meet})` : ""}`);
          told = `summary sent on WhatsApp to ${phone}`;
        } else told = `WhatsApp window closed for ${phone}, invite by email only`;
      }
      logs.push(`self-command: booked ${cmd.name ?? "meeting"} ${slotLabel(cmd.start, s.tz)} for ${cmd.email} (${ev.meet ?? "no link"}); ${told}`);
    } catch (e) {
      logs.push(`self-command failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const l of logs) console.log(l);
  if (logs.length) await d.state.set("self:last", JSON.stringify({ at: Date.now(), logs }), { ex: 30 * 86400 }).catch(() => {});
  return logs;
}

/** The merchant's chat: the email written in a chat, else the store name in the CRM sheet or a chat name. */
async function findChat(d: Deps, cmd: BookCommand): Promise<string | undefined> {
  const byEmail = await new ChatMatcher(d.store).chatFor({ id: "", start: 0, end: 0, emails: [cmd.email.toLowerCase()] });
  if (byEmail) return byEmail;
  if (!cmd.name) return undefined;
  const bySheet = await phoneForStore(d.base, cmd.name).catch(() => undefined);
  if (bySheet) return bySheet;
  const want = cmd.name.replace(/\s+/g, " ").trim();
  const hits = (await d.store.conversations(200)).filter((c) => c.name && c.name.trim() === want);
  return hits.length === 1 ? hits[0].waId : undefined;
}
