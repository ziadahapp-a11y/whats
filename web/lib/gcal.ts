// Google Calendar for the official number: Zaid books meetings in free time inside working hours,
// and reminds the merchant on the day. One Google account per deployment, connected once from the dashboard
// (OAuth with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET); the refresh token stays in Redis.

import { randomBytes } from "node:crypto";
import type { RawKV } from "./wa/auth";

const TOKEN = "meta:gcal:token";
const SETTINGS = "meta:gcal:settings";
const STATE = "meta:gcal:state:";
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy", "openid", "email"];
const API = "https://www.googleapis.com/calendar/v3";

export type Settings = {
  /** 0 = Sunday ... 6 = Saturday */
  days: number[];
  start: string; // "10:00"
  end: string; // "16:00"
  minutes: number;
  gap: number;
  noticeHours: number;
  aheadDays: number;
  tz: string;
  title: string;
};

export const DEFAULT_SETTINGS: Settings = { days: [0, 1, 2, 3, 4], start: "10:00", end: "16:00", minutes: 30, gap: 15, noticeHours: 2, aheadDays: 7, tz: "Asia/Riyadh", title: "اجتماع زيادة" };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function cleanSettings(s: Partial<Settings>): Settings {
  const n = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);
  const d = DEFAULT_SETTINGS;
  const days = Array.isArray(s.days) ? [...new Set(s.days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : d.days;
  const start = typeof s.start === "string" && HHMM.test(s.start) ? s.start : d.start;
  const end = typeof s.end === "string" && HHMM.test(s.end) && s.end > start ? s.end : d.end;
  let tz = d.tz;
  try {
    if (typeof s.tz === "string" && s.tz) new Intl.DateTimeFormat("en", { timeZone: s.tz }), (tz = s.tz);
  } catch {}
  const title = typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 100) : d.title;
  return { days, start, end, tz, title, minutes: n(s.minutes, 10, 240, d.minutes), gap: n(s.gap, 0, 120, d.gap), noticeHours: n(s.noticeHours, 0, 72, d.noticeHours), aheadDays: n(s.aheadDays, 1, 30, d.aheadDays) };
}

export async function getSettings(base: RawKV): Promise<Settings> {
  try {
    return cleanSettings(JSON.parse((await base.get(SETTINGS)) ?? "{}"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = async (base: RawKV, s: Partial<Settings>) => {
  const clean = cleanSettings(s);
  await base.set(SETTINGS, JSON.stringify(clean));
  return clean;
};

// ---------- time helpers (no date library: offsets come from Intl) ----------

/** minutes the zone is ahead of UTC at this instant */
function offsetMinutes(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** the local calendar date (y, m, d) and weekday at an instant */
export function localDay(ms: number, tz: string) {
  const local = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), weekday: local.getUTCDay() };
}

/** a local wall-clock time on a local date, as epoch ms */
export function atLocal(y: number, m: number, d: number, hhmm: string, tz: string): number {
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - offsetMinutes(guess - offsetMinutes(guess, tz) * 60000, tz) * 60000;
}

export const slotLabel = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export const timeLabel = (ms: number, tz: string) => new Intl.DateTimeFormat("ar-SA-u-nu-latn", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));

/** ISO local time without offset, the form Zaid uses to name a slot: 2026-11-02T10:30 */
export function localIso(ms: number, tz: string) {
  const local = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return local.toISOString().slice(0, 16);
}

export type Busy = { start: number; end: number };

/** Free slots inside working hours, at least noticeHours ahead, kept clear of busy time by `gap` minutes. */
export function freeSlots(s: Settings, busy: Busy[], now: number, max = 8): number[] {
  const out: number[] = [];
  const len = s.minutes * 60000;
  const gap = s.gap * 60000;
  const earliest = now + s.noticeHours * 3600000;
  for (let i = 0; i <= s.aheadDays && out.length < max; i++) {
    const day = localDay(now + i * 86400000, s.tz);
    if (!s.days.includes(day.weekday)) continue;
    const open = atLocal(day.y, day.m, day.d, s.start, s.tz);
    const close = atLocal(day.y, day.m, day.d, s.end, s.tz);
    for (let t = open; t + len <= close && out.length < max; t += len + gap) {
      if (t < earliest) continue;
      if (busy.some((b) => t < b.end + gap && t + len + gap > b.start)) continue;
      out.push(t);
    }
  }
  return out;
}

/** Spread the offer over days: at most `perDay` slots from each day. */
export function spread(slots: number[], tz: string, perDay = 2, max = 6): number[] {
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (const t of slots) {
    const d = localIso(t, tz).slice(0, 10);
    if ((seen.get(d) ?? 0) >= perDay) continue;
    seen.set(d, (seen.get(d) ?? 0) + 1);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- OAuth ----------

type Env = Record<string, string | undefined>;
export const googleConfigured = (env: Env = process.env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const redirectUri = (publicBase: string, env: Env = process.env) => env.GOOGLE_REDIRECT_URI || `${publicBase}/api/google/callback`;

export async function authUrl(base: RawKV, publicBase: string, env: Env = process.env): Promise<string> {
  const state = randomBytes(16).toString("hex");
  await base.set(STATE + state, "1", { ex: 600 });
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? "", redirect_uri: redirectUri(publicBase, env), response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type Stored = { refresh: string; email?: string; access?: string; exp?: number };

async function tokenCall(body: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google: ${data.error_description ?? data.error ?? res.status}`);
  return data;
}

export async function finishAuth(base: RawKV, code: string, state: string, publicBase: string, env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (!/^[0-9a-f]{32}$/.test(state) || !(await base.get(STATE + state))) throw new Error("The link expired. Press Connect Google again.");
  await base.del(STATE + state);
  const data = await tokenCall({ code, client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(publicBase, env), grant_type: "authorization_code" }, fetchImpl);
  if (!data.refresh_token) throw new Error("Google did not return a refresh token. Remove Zaid's access in your Google account, then connect again.");
  let email: string | undefined;
  try {
    email = JSON.parse(Buffer.from(String(data.id_token).split(".")[1], "base64url").toString()).email;
  } catch {}
  const stored: Stored = { refresh: data.refresh_token, email, access: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  await base.set(TOKEN, JSON.stringify(stored));
  return email;
}

export async function connection(base: RawKV): Promise<{ connected: boolean; email?: string }> {
  try {
    const s = JSON.parse((await base.get(TOKEN)) ?? "null") as Stored | null;
    return s?.refresh ? { connected: true, email: s.email } : { connected: false };
  } catch {
    return { connected: false };
  }
}

export const disconnect = (base: RawKV) => base.del(TOKEN);

// ---------- Calendar API ----------

export type CalEvent = {
  id: string;
  start: number;
  end: number;
  /** set on meetings Zaid booked */
  chat?: string;
  summary?: string;
  meet?: string;
  /** guests other than the calendar owner */
  emails?: string[];
  /** description and location, where booking pages put the phone number */
  text?: string;
  created?: number;
};

export class Calendar {
  constructor(private base: RawKV, private env: Env = process.env, private fetchImpl: typeof fetch = fetch) {}

  private async token(): Promise<string> {
    const s = JSON.parse((await this.base.get(TOKEN)) ?? "null") as Stored | null;
    if (!s?.refresh) throw new Error("Google Calendar is not connected.");
    if (s.access && s.exp && s.exp > Date.now() + 60_000) return s.access;
    const data = await tokenCall({ refresh_token: s.refresh, client_id: this.env.GOOGLE_CLIENT_ID ?? "", client_secret: this.env.GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token" }, this.fetchImpl);
    await this.base.set(TOKEN, JSON.stringify({ ...s, access: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }));
    return data.access_token;
  }

  private async api(path: string, init: RequestInit = {}) {
    const res = await this.fetchImpl(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${await this.token()}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${data?.error?.message ?? res.statusText}`);
    return data;
  }

  async busy(from: number, to: number): Promise<Busy[]> {
    const data = await this.api("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: "primary" }] }) });
    return (data.calendars?.primary?.busy ?? []).map((b: any) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }

  async book(o: { start: number; end: number; title: string; email: string; chat: string; name?: string; tz: string; store?: string }): Promise<CalEvent> {
    const body = {
      summary: o.name ? `${o.title} - ${o.name}` : o.title,
      description: `حجزه زيد من واتساب. رقم التاجر: +${o.chat}${o.store ? `\nرابط المتجر: ${o.store}` : ""}`,
      start: { dateTime: new Date(o.start).toISOString(), timeZone: o.tz },
      end: { dateTime: new Date(o.end).toISOString(), timeZone: o.tz },
      attendees: [{ email: o.email }],
      conferenceData: { createRequest: { requestId: randomBytes(8).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      extendedProperties: { private: { zaidChat: o.chat } },
    };
    const e = await this.api("/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", { method: "POST", body: JSON.stringify(body) });
    return toEvent(e);
  }

  /** timed, non-cancelled events that start in [from, to): meetings Zaid booked and any others */
  async events(from: number, to: number): Promise<CalEvent[]> {
    const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    const data = await this.api(`/calendars/primary/events?${q}`);
    return (data.items ?? []).filter((e: any) => e.status !== "cancelled" && e.start?.dateTime).map(toEvent).filter((e: CalEvent) => e.start >= from);
  }
}

const toEvent = (e: any): CalEvent => ({
  id: e.id,
  start: Date.parse(e.start?.dateTime ?? e.start?.date),
  end: Date.parse(e.end?.dateTime ?? e.end?.date),
  chat: e.extendedProperties?.private?.zaidChat,
  summary: e.summary,
  meet: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === "video")?.uri,
  emails: (e.attendees ?? []).filter((x: any) => !x.self && !x.resource && x.email).map((x: any) => String(x.email).toLowerCase()),
  text: `${e.description ?? ""}\n${e.location ?? ""}`,
  created: e.created ? Date.parse(e.created) : undefined,
});
