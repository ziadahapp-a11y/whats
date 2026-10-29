"use client";

import { useEffect, useState } from "react";
import { call, errMsg, invalidate, useApi } from "../shared";

type Settings = { days: number[]; start: string; end: string; minutes: number; gap: number; noticeHours: number; aheadDays: number; tz: string; title: string };
type Data = { configured: boolean; connected: boolean; email?: string; redirectUri: string; settings: Settings };

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const PATH = "/api/personal/calendar";

/** Google Calendar for Zaid on the official number: connect once, then set working hours. */
export function CalendarPanel({ secret }: { secret: string }) {
  const api = useApi<Data>(PATH, { fresh: 30_000 });
  const d = api.data;
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (d?.settings) setS(d.settings);
  }, [d?.settings]);

  useEffect(() => {
    // Google sends the browser back with ?calendar=<result>
    const r = new URLSearchParams(window.location.search).get("calendar");
    if (r) setMsg({ ok: r.startsWith("تم"), text: r });
  }, []);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      invalidate(PATH);
      await api.reload();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy("");
    }
  }

  const connect = () =>
    run("connect", async () => {
      const { url } = await call<{ url: string }>(secret, PATH, { body: { op: "connect" } });
      window.location.href = url;
    }, "");

  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => s && setS({ ...s, [k]: Number(e.target.value) });

  return (
    <section className="card">
      <h3>تقويم Google لحجز الاجتماعات</h3>
      <p className="hint">زيد يقترح على التاجر أوقات فاضية من تقويمك ضمن ساعات العمل، ويحجز اللي يختاره مع رابط Google Meet ودعوة على إيميله، ويذكّره يوم الموعد. أي وقت ما تبيه، سكّره بموعد في التقويم.</p>
      {!d ? (
        <p className="hint">…</p>
      ) : !d.configured ? (
        <p className="hint">أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في Vercel ثم أعد النشر.</p>
      ) : (
        <>
          <div className="row">
            {d.connected ? <span className="tag">مربوط{d.email ? `: ${d.email}` : ""}</span> : <span className="sub">غير مربوط</span>}
            <button className="btn solid" disabled={!!busy} onClick={connect}>{busy === "connect" ? "…" : d.connected ? "أعد الربط" : "ربط Google"}</button>
            {d.connected && <button className="btn ghost small danger" disabled={!!busy} onClick={() => run("off", () => call(secret, PATH, { body: { op: "disconnect" } }), "انفصل التقويم")}>فصل</button>}
          </div>
          <p className="sub" dir="ltr">Redirect URI: {d.redirectUri}</p>
        </>
      )}
      {s && (
        <>
          <div className="row" role="group" aria-label="أيام العمل">
            {DAYS.map((name, i) => (
              <label key={i} className="check">
                <input type="checkbox" checked={s.days.includes(i)} onChange={(e) => setS({ ...s, days: e.target.checked ? [...s.days, i].sort() : s.days.filter((x) => x !== i) })} />
                {name}
              </label>
            ))}
          </div>
          <div className="grid2">
            <label>من الساعة<input type="time" value={s.start} onChange={(e) => setS({ ...s, start: e.target.value })} /></label>
            <label>إلى الساعة<input type="time" value={s.end} onChange={(e) => setS({ ...s, end: e.target.value })} /></label>
            <label>مدة الاجتماع (دقيقة)<input type="number" min={10} max={240} value={s.minutes} onChange={num("minutes")} /></label>
            <label>فاصل بين الاجتماعات (دقيقة)<input type="number" min={0} max={120} value={s.gap} onChange={num("gap")} /></label>
            <label>أقل وقت قبل الحجز (ساعة)<input type="number" min={0} max={72} value={s.noticeHours} onChange={num("noticeHours")} /></label>
            <label>الحجز خلال (يوم)<input type="number" min={1} max={30} value={s.aheadDays} onChange={num("aheadDays")} /></label>
            <label>عنوان الاجتماع<input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></label>
          </div>
          <button className="btn solid" disabled={!!busy} onClick={() => run("save", () => call(secret, PATH, { body: { op: "settings", settings: s } }), "انحفظت الإعدادات")}>{busy === "save" ? "…" : "حفظ"}</button>
        </>
      )}
      {msg && <div className={`banner ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
    </section>
  );
}
