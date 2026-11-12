"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Overview as Data } from "@/lib/overview";
import { call, errMsg, useApi, useSession, when } from "../shared";
import { State } from "../State";

// stat card icons, 24px stroke paths
const ICO = {
  in: "M12 4v12m0 0l-4-4m4 4l4-4M5 20h14",
  chats: "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 20a8 8 0 0116 0",
  wait: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  draft: "M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4zM13.5 6.5l4 4",
  runs: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  error: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 8v5M12 16h.01",
  ai: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
};

type Resp = Data & { flows: { total: number; enabled: number; paused: boolean }; ai: { configured: boolean; dailyCap: number } };

const hoursAgo = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / 3600_000));
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "الحين" : m < 60 ? `قبل ${m} دقيقة` : m < 48 * 60 ? `قبل ${Math.round(m / 60)} ساعة` : `قبل ${Math.round(m / 1440)} يوم`;
};

/** "in 25 min" while waiting, or a plain note once the time has passed and the next sync will pick it up. */
const until = (ms: number) => {
  const m = Math.round((ms - Date.now()) / 60_000);
  if (m <= 0) return "حان وقتها، تكمل مع المزامنة الجاية";
  return m < 60 ? `تكمل بعد ${m} دقيقة` : m < 48 * 60 ? `تكمل بعد ${Math.round(m / 60)} ساعة` : `تكمل بعد ${Math.round(m / 1440)} يوم`;
};

export function Overview() {
  const api = useApi<Resp>("/api/personal/overview", { fresh: 20_000, poll: 30_000 });
  const { secret, status } = useSession();
  const who = status.accounts.find((a) => a.paired);
  const [cancelling, setCancelling] = useState("");
  const [cancelError, setCancelError] = useState("");
  const d = api.data;

  async function cancelWait(w: Data["waits"][number]) {
    if (!confirm(`إلغاء انتظار "${w.flowName}"؟ الخطوات اللي بعده ما راح تشتغل لهذي المحادثة.`)) return;
    setCancelling(w.id);
    setCancelError("");
    try {
      await call(secret, "/api/personal/flows", { body: { op: "cancel_wait", account: w.account, id: w.id } });
      // drop it from what is on screen at once; the reload brings the next one into the list of five
      api.set((prev) => {
        const x = prev!; // the button only exists once the data is on screen
        return { ...x, waits: x.waits.filter((y) => y.id !== w.id), totals: { ...x.totals, waiting: Math.max(0, x.totals.waiting - 1) }, accounts: x.accounts.map((a) => (a.id === w.account ? { ...a, waiting: Math.max(0, a.waiting - 1) } : a)) };
      });
      await api.reload();
    } catch (e) {
      setCancelError(errMsg(e));
    } finally {
      setCancelling("");
    }
  }

  if (!d) {
    return (
      <div className="page">
        <Head onRefresh={api.reload} busy={api.loading} name={who?.name} />
        {api.error ? (
          <State
            tone="bad"
            title="ما قدرنا نحمّل نظرة عامة"
            actions={
              <>
                <button type="button" className="btn brand" onClick={() => void api.reload()}>جرّب مرة ثانية</button>
                <Link className="btn white" href="/guide">دليل الإعداد</Link>
              </>
            }
          >
            ما وصلنا للسيرفر. تأكد من اتصالك وجرّب مرة ثانية. ما ضاع شي من إعداداتك. ({api.error})
          </State>
        ) : (
          <>
            <p className="loading-note">نحمّل نظرة عامة…</p>
            <div className="kpis">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skel" style={{ height: 96 }} />)}</div>
            <div className="skel" style={{ height: 220 }} />
          </>
        )}
      </div>
    );
  }

  const t = d.totals;
  const runs = t.runs.ok + t.runs.draft + t.runs.dry + t.runs.error + t.runs.skipped;
  const aiPct = Math.min(100, Math.round((t.aiUsed / d.ai.dailyCap) * 100));
  const alerts: { tone: "bad" | "warn"; text: ReactNode }[] = [];
  if (d.flows.paused) alerts.push({ tone: "bad", text: <>كل الفلوات موقوفة. <Link href="/personal/flows">شغّلها من صفحة الفلوات</Link></> });
  for (const a of d.accounts) {
    if (a.kind === "personal" && a.paired === false) alerts.push({ tone: "bad", text: <>الرقم "{a.label}" غير مربوط. <Link href="/personal">اربطه من الأرقام والمفاتيح</Link></> });
    else if (a.kind === "personal" && (a.lastSync === null || hoursAgo(a.lastSync * 1000) >= 24))
      alerts.push({ tone: "warn", text: <>الرقم "{a.label}" ما تزامن {a.lastSync ? ago(a.lastSync * 1000) : "أبداً"}. بدون مزامنة ما توصل رسائل جديدة ولا تشتغل الفلوات.</> });
  }
  if (d.flows.enabled > 0 && !d.ai.configured) alerts.push({ tone: "warn", text: "عندك فلوات مفعّلة لكن الذكاء الاصطناعي غير مفعّل، فالخطوات اللي تحتاجه راح تفشل." });
  if (t.aiUsed >= d.ai.dailyCap) alerts.push({ tone: "bad", text: "وصلت الحد اليومي للذكاء الاصطناعي، خطوات الذكاء توقفت لين يتصفّر العداد." });

  return (
    <div className="page overview">
      <Head onRefresh={api.reload} busy={api.loading} name={who?.name} />

      {alerts.length > 0 && (
        <div className="alerts" role="status">
          {alerts.map((a, i) => <div key={i} className={`banner ${a.tone === "bad" ? "bad" : "warnb"}`}>{a.text}</div>)}
        </div>
      )}

      <div className="kpis">
        <Kpi icon={ICO.in} label="رسائل واردة" value={t.messagesIn} sub={`صادرة ${t.messagesOut}`} />
        <Kpi icon={ICO.chats} label="محادثات نشطة" value={t.activeChats} sub={`${d.accounts.length} ${d.accounts.length === 1 ? "رقم" : "أرقام"}`} />
        <Kpi icon={ICO.wait} label="تشغيلات تنتظر" value={t.waiting} sub={t.waiting ? "عند عقدة انتظار" : "ما فيه شي معلّق"} />
        <Kpi icon={ICO.draft} label="مسودات تنتظرك" value={t.drafts} tone={t.drafts ? "warn" : undefined} href="/personal/inbox" sub={t.drafts ? "راجعها في الوارد" : "ما فيه شي معلّق"} />
        <Kpi icon={ICO.runs} label="تشغيلات الفلوات" value={runs} href="/personal/flows?tab=log" sub={`تم ${t.runs.ok} · مسودة ${t.runs.draft}${t.runs.dry ? ` · تجربة ${t.runs.dry}` : ""}${t.runs.skipped ? ` · تخطّى ${t.runs.skipped}` : ""}`} />
        <Kpi icon={ICO.error} label="أخطاء الفلوات" value={t.runs.error} tone={t.runs.error ? "bad" : undefined} href="/personal/flows?tab=log" sub={t.runs.error ? "افتح السجل للتفاصيل" : "كل شي سليم"} />
        <div className="kpi">
          <Ico d={ICO.ai} />
          <strong>{t.aiUsed}<small> / {d.ai.dailyCap}</small></strong>
          <span className="kpi-label">الذكاء الاصطناعي اليوم</span>
          <div className="meter" aria-hidden="true"><span style={{ width: `${aiPct}%` }} /></div>
          <span className="kpi-sub">يبدأ العداد من جديد منتصف الليل بتوقيت UTC</span>
        </div>
      </div>

      <section className="card">
        <div className="section-head">
          <h3>النشاط آخر 24 ساعة</h3>
          <div className="legend"><span><i className="sw-in" /> واردة</span><span><i className="sw-out" /> صادرة</span></div>
        </div>
        <Chart hourly={d.hourly} />
      </section>

      <div className="two">
        <section className="card">
          <div className="section-head"><h3>مسودات تنتظر موافقتك</h3>{t.drafts > 5 && <Link className="btn ghost small" href="/personal/inbox">كلها ({t.drafts})</Link>}</div>
          {d.drafts.length === 0 ? <p className="empty">ما فيه مسودات.</p> : (
            <ul className="list">
              {d.drafts.map((x) => (
                <li key={x.id}>
                  <div className="grow">
                    <strong>{x.chatName || "+" + x.chat.split("@")[0]}</strong>
                    <span className="sub">{x.text}</span>
                  </div>
                  <span className="tag">{x.flowName}</span>
                  <Link className="btn ghost small" href="/personal/inbox">راجع</Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="section-head"><h3>آخر الأخطاء</h3></div>
          {d.errors.length === 0 ? <p className="empty">ما فيه أخطاء آخر 24 ساعة.</p> : (
            <ul className="list">
              {d.errors.map((x, i) => (
                <li key={x.id ?? i}>
                  <div className="grow">
                    <strong>{x.name}</strong>
                    <span className="sub err">{x.detail ?? "خطأ"}</span>
                  </div>
                  <span className="tag">{ago(x.t)}</span>
                  {x.id && <Link className="btn ghost small" href={`/personal/flows/run/${x.id}`}>التفاصيل</Link>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {(t.waiting > 0 || cancelError) && (
        <section className="card">
          <div className="section-head"><h3>تشغيلات تنتظر عند عقدة انتظار</h3>{t.waiting > 5 && <span className="tag">أقرب 5 من {t.waiting}</span>}</div>
          {cancelError && <div className="banner bad">{cancelError}</div>}
          <ul className="list">
            {d.waits.map((w) => (
              <li key={w.id}>
                <div className="grow">
                  <strong>{w.flowName}</strong>
                  <span className="sub">{w.chat ? w.chatName || "+" + w.chat.split("@")[0].split(":")[0] : "فلو مجدول"} · {w.accountLabel}{w.cancelOnReply ? " · يلغى لو ردّ" : ""}</span>
                </div>
                <span className="tag">{until(w.resumeAt)}</span>
                <button type="button" className="btn ghost small danger" disabled={cancelling === w.id} onClick={() => void cancelWait(w)}>{cancelling === w.id ? "…" : "ألغِ"}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>الأرقام</h3>
        <div className="table-scroll">
          <table className="logtable stack-table">
            <thead><tr><th>الرقم</th><th>الحالة</th><th>آخر مزامنة</th><th>محادثات نشطة</th><th>واردة / صادرة</th><th>مسودات</th><th>تنتظر</th><th>أخطاء</th></tr></thead>
            <tbody>
              {d.accounts.map((a) => (
                <tr key={a.id}>
                  <td data-label="الرقم"><strong>{a.label}</strong></td>
                  <td data-label="الحالة">{a.kind === "official" ? <span className="chip on">رسمي</span> : a.paired ? <span className="chip on">مربوط</span> : <span className="chip off">غير مربوط</span>}</td>
                  <td data-label="آخر مزامنة">{a.kind === "official" ? "لحظي" : when(a.lastSync)}</td>
                  <td data-label="محادثات نشطة">{a.activeChats}</td>
                  <td data-label="واردة / صادرة">{a.messagesIn} / {a.messagesOut}</td>
                  <td data-label="مسودات">{a.drafts}</td>
                  <td data-label="تنتظر">{a.waiting}</td>
                  <td data-label="أخطاء" className={a.runs.error ? "err" : ""}>{a.runs.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Head({ onRefresh, busy, name }: { onRefresh: () => Promise<void>; busy: boolean; name?: string }) {
  return (
    <div className="page-head">
      <div>
        <h2>{name ? `أهلاً بعودتك، ${name}` : "أهلاً بعودتك"}</h2>
        <p className="intro">نظرة سريعة على نشاط أرقامك وفلواتك آخر 24 ساعة. تتحدث كل نص دقيقة تقريباً.</p>
      </div>
      <button type="button" className="btn solid" onClick={() => void onRefresh()} disabled={busy}>{busy ? "نحدّث…" : "حدّث الآن"}</button>
    </div>
  );
}

const Ico = ({ d }: { d: string }) => (
  <span className="ico" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  </span>
);

function Kpi({ icon, label, value, sub, tone, href }: { icon: string; label: string; value: number; sub?: string; tone?: "bad" | "warn"; href?: string }) {
  const body = (
    <>
      <Ico d={icon} />
      <strong>{value.toLocaleString("ar-u-nu-latn")}</strong>
      <span className="kpi-label">{label}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  const cls = `kpi${tone ? ` ${tone}` : ""}`;
  return href ? <Link href={href} className={`${cls} link`}>{body}</Link> : <div className={cls}>{body}</div>;
}

function Chart({ hourly }: { hourly: Data["hourly"] }) {
  const max = Math.max(1, ...hourly.map((h) => h.in + h.out));
  const total = hourly.reduce((s, h) => s + h.in + h.out, 0);
  const W = 720, H = 150, base = 124, bw = 22, step = W / hourly.length;
  if (!total) return <div className="chart-empty">ما فيه رسائل آخر 24 ساعة. أول ما توصل رسائل أو تزامن، يطلع النشاط هنا.</div>;
  return (
    <div className="chart" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${total} رسالة في آخر 24 ساعة`} preserveAspectRatio="xMidYMid meet">
        {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={base - f * 100} y2={base - f * 100} className="grid" />)}
        {hourly.map((h, i) => {
          const x = i * step + (step - bw) / 2;
          const hi = (h.in / max) * 100;
          const ho = (h.out / max) * 100;
          return (
            <g key={h.t}>
              <title>{`${new Date(h.t).toLocaleTimeString("ar", { hour: "numeric" })}: واردة ${h.in}، صادرة ${h.out}`}</title>
              <rect x={x} y={base - hi} width={bw} height={hi} rx="3" className="bar-in" />
              <rect x={x} y={base - hi - ho} width={bw} height={ho} rx="3" className="bar-out" />
              {i % 4 === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis">{new Date(h.t).toLocaleTimeString("en", { hour: "2-digit", hour12: false })}:00</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
