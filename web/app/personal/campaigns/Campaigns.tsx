"use client";

import { useEffect, useState } from "react";
import { call, errMsg, invalidate, uploadPieces, useApi, useSession } from "../shared";
import { SUGGESTED_TEMPLATES, type SuggestedTemplate } from "@/lib/suggested-templates";
import { State } from "../State";

type Check = { id: string; ok: boolean; message: string };
type Blocked = { sourceRow?: number; reason: string; detail: string };
type DryRun = {
  campaignId?: string;
  confirmToken?: string;
  pilotSize?: number;
  ok: boolean;
  checks: Check[];
  summary: { total: number; accepted: number; blocked: number; byReason: Record<string, number>; newUnique: number; remainingCapacity: number };
  blocked: Blocked[];
  blockedTruncated: boolean;
};
type View = {
  id: string;
  status: string;
  template: { name: string; language: string; paramCount: number };
  total: number;
  cursor: number;
  remaining: number;
  sent: number;
  failed: number;
  skipped: number;
  skippedBy: Record<string, number>;
  pilotSize: number;
  resumeAt?: number;
  startedAt?: number;
  haltReason?: string;
  haltCode?: number;
  busy?: boolean;
};
type Report = View & { delivered: number; read: number; pending: number; failureRate: number; errors: { code: number | null; count: number; meaning?: string }[] };
type Tpl = { name: string; language: string; status: string; category: string };
type Overview = {
  number: { ok: boolean; error?: string; quality_rating?: string; messaging_limit_tier?: string; status?: string; name_status?: string; verified_name?: string; display_phone_number?: string };
  templates: { ok: boolean; error?: string; data?: Tpl[] };
  campaigns: View[];
};
type Upload = { uploadId: string; filename: string; rows: number; paramCount: number; warnings: string[]; sample: { sourceRow: number; phone: string; consentAt: string; params: string[] }[] };
type Issue = { level: "error" | "warning"; field: string; message: string };
type TplResult = { ok: false; issues: Issue[] } | { ok: true; submitted: boolean; warnings: Issue[]; meta?: { status: string }; paramCount: number };

const REASON: Record<string, string> = {
  invalid_phone: "رقم غير سعودي أو غير صالح",
  duplicate: "مكرر في الملف",
  no_consent_source: "بدون مصدر موافقة",
  no_consent_date: "بدون تاريخ موافقة",
  invalid_consent_date: "تاريخ الموافقة غير صالح (اكتبه 2026-09-01 أو اجعله تاريخاً في إكسل)",
  future_consent_date: "تاريخ الموافقة في المستقبل",
  opted_out: "منسحب من الرسائل",
  cooldown: "وصلته رسالة تسويقية خلال آخر 7 أيام",
  missing_param: "قيمة متغير ناقصة",
  bad_param: "قيمة متغير غير مقبولة (سطر جديد أو مسافات كثيرة)",
};
const STATUS: Record<string, string> = {
  dry_run: "جاهزة للبدء",
  running: "شغالة",
  waiting: "انتظار بعد الدفعة التجريبية",
  halted: "متوقفة",
  completed: "اكتملت",
  cancelled: "ملغاة",
};
const LIVE = ["running", "waiting", "halted"];
const tone = (s: string) => (s === "completed" || s === "running" || s === "APPROVED" ? "ok" : s === "halted" || s === "REJECTED" || s === "cancelled" || s === "DISABLED" || s === "PAUSED" ? "error" : "draft");

export function Campaigns() {
  const { secret } = useSession();
  return <App secret={secret} />;
}

const emptyDraft = { name: "", language: "ar", category: "MARKETING" as "MARKETING" | "UTILITY", header: "", body: "", examples: [] as string[], footer: "", optOut: true, urlText: "", url: "", urlExample: "" };

function App({ secret }: { secret: string }) {
  const overview = useApi<Overview>("/api/personal/campaigns", { fresh: 10_000, poll: 30_000 });
  const data = overview.data;
  const post = <T = any,>(body: unknown) => call<T>(secret, "/api/personal/campaigns", { body });

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [tplKey, setTplKey] = useState("");
  const [dry, setDry] = useState<DryRun | null>(null);
  const [active, setActive] = useState<View | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [driving, setDriving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState(emptyDraft);
  const [tplResult, setTplResult] = useState<TplResult | null>(null);
  const [headerImg, setHeaderImg] = useState<File | null>(null);

  // Fills the form from a ready-made template; its sample header image comes from /public.
  async function fillSuggested(t: SuggestedTemplate) {
    setTplResult(null);
    setDraft({ ...emptyDraft, name: t.name, category: t.category, body: t.body, examples: t.examples, footer: t.footer ?? "", optOut: !!t.optOut, urlText: t.urlText ?? "", url: t.url ?? "" });
    setHeaderImg(null);
    if (t.image) {
      const blob = await (await fetch(t.image)).blob();
      setHeaderImg(new File([blob], t.image.split("/").pop()!, { type: blob.type || "image/png" }));
    }
  }

  const live = data?.campaigns.find((c) => LIVE.includes(c.status));
  const current = active ?? live ?? null;
  const usable = (data?.templates.data ?? []).filter((t) => t.status === "APPROVED" && t.category === "MARKETING");

  async function run(key: string, fn: () => Promise<unknown>, ok = "") {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy("");
    }
  }

  const refresh = async () => {
    invalidate("/api/personal/campaigns");
    await overview.reload();
  };

  // A ticking clock only while the campaign waits after its pilot batch.
  useEffect(() => {
    if (current?.status !== "waiting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [current?.status]);

  // Sends batch after batch while this page is open; the campaign stops by itself if the page closes.
  useEffect(() => {
    if (!driving || !current) return;
    const id = current.id;
    let stop = false;
    (async () => {
      try {
        while (!stop) {
          const v = await post<View>({ op: "advance", id });
          if (stop) return;
          setActive(v);
          if (v.busy) await new Promise((r) => setTimeout(r, 3000));
          else if (v.status === "waiting") {
            while (!stop && Date.now() < (v.resumeAt ?? 0) + 500) await new Promise((r) => setTimeout(r, 1000));
          } else if (v.status !== "running") break;
        }
      } catch (e) {
        setMsg({ ok: false, text: errMsg(e) });
      } finally {
        if (!stop) {
          setDriving(false);
          void refresh();
        }
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving, current?.id]);

  async function sendFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setDry(null);
    setUpload(null);
    await run("upload", async () => {
      const form = new FormData();
      form.append("file", f);
      const r = await fetch("/api/personal/campaigns", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setUpload(d as Upload);
    });
  }

  const [tplName, tplLang] = tplKey.split("|");

  async function loadReport(id: string) {
    await run("report", async () => setReport(await call<Report>(secret, `/api/personal/campaigns?id=${id}`)));
  }

  const vars = new Set([...draft.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
  function buildDraft() {
    return {
      name: draft.name,
      language: draft.language,
      category: draft.category,
      ...(draft.header.trim() && !headerImg ? { header: { type: "TEXT", text: draft.header } } : {}),
      body: draft.body,
      bodyExamples: Array.from({ length: vars }, (_, i) => draft.examples[i] ?? ""),
      ...(draft.footer.trim() ? { footer: draft.footer } : {}),
      buttons: [
        ...(draft.optOut ? [{ type: "QUICK_REPLY", text: "إيقاف" }] : []),
        ...(draft.url.trim() ? [{ type: "URL", text: draft.urlText, url: draft.url, urlExample: draft.urlExample || undefined }] : []),
      ],
    };
  }

  const n = data?.number;
  const pct = current && current.total ? Math.round((current.cursor / current.total) * 100) : 0;
  const waitLeft = current?.resumeAt ? Math.max(0, Math.ceil((current.resumeAt - now) / 1000)) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>الحملات التسويقية</h2>
          <p className="intro">رسائل تسويقية عبر واجهة واتساب الرسمية (Cloud API). كل حملة تبدأ بفحص بدون إرسال، ثم دفعة تجريبية صغيرة، ويوقفها قاطع تلقائي لو نزلت جودة الرقم أو ظهرت أخطاء من Meta.</p>
        </div>
      </div>

      {msg && <div className={`banner ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
      {overview.error && !data && (
        <State tone="bad" title="ما قدرنا نحمّل الحملات" actions={<button type="button" className="btn solid" onClick={() => void overview.reload()}>جرّب مرة ثانية</button>}>
          {overview.error}
        </State>
      )}

      {data && (
        <section className="card">
          <h3>حالة الرقم</h3>
          {n?.ok ? (
            <div className="row" style={{ alignItems: "center" }}>
              <span className={`status ${n.status === "CONNECTED" ? "ok" : "draft"}`}>{n.status ?? "—"}</span>
              <span className={`status ${n.quality_rating === "GREEN" ? "ok" : "error"}`} title="جودة الرقم">الجودة: {n.quality_rating ?? "—"}</span>
              <span className="tag" dir="ltr">{n.messaging_limit_tier ?? "—"}</span>
              <span className="tag" dir="ltr">{n.display_phone_number}</span>
              {n.verified_name && <span className="tag">{n.verified_name}</span>}
            </div>
          ) : (
            <p className="err">ما قدرنا نقرأ حالة الرقم من Meta: {n?.error}. تأكد من WHATSAPP_ACCESS_TOKEN و WHATSAPP_PHONE_NUMBER_ID.</p>
          )}
          {n?.ok && n.quality_rating !== "GREEN" && <p className="hint">الحملات ما تشتغل إلا والجودة GREEN.</p>}
        </section>
      )}

      {current && (
        <section className="card fresh">
          <h3>
            حملة {current.template.name} <span className={`status ${tone(current.status)}`}>{STATUS[current.status] ?? current.status}</span>
          </h3>
          <div className="meter" aria-label={`${pct}%`}><span style={{ width: `${pct}%` }} /></div>
          <p>
            <strong>{current.cursor}</strong> من {current.total} · أُرسلت {current.sent} · فشلت {current.failed} · تخطّينا {current.skipped}
            {current.skipped > 0 && <span className="hint"> ({Object.entries(current.skippedBy).map(([k, v]) => `${k === "opted_out" ? "منسحب" : "أُرسلت قبل"} ${v}`).join("، ")})</span>}
          </p>
          {current.status === "waiting" && <p className="hint">انتهت الدفعة التجريبية ({current.pilotSize}). ننتظر {waitLeft} ثانية لنقرأ نتائج التسليم قبل ما نكمل. افتح التقرير وراجع الأخطاء.</p>}
          {current.status === "halted" && <p className="err" role="alert">توقفت: {current.haltReason}</p>}
          {driving && <p className="hint">الإرسال شغال. أبقِ هذه الصفحة مفتوحة؛ لو أغلقتها تقف الحملة مكانها وتكملها من هنا.</p>}
          <div className="actions" style={{ marginTop: 12 }}>
            {(current.status === "running" || current.status === "waiting") && !driving && <button className="btn solid" onClick={() => setDriving(true)}>تابع الإرسال</button>}
            {(current.status === "running" || current.status === "waiting") && (
              <button className="btn ghost" disabled={busy === "ctl"} onClick={() => run("ctl", async () => { setDriving(false); setActive(await post<View>({ op: "control", id: current.id, action: "pause" })); await refresh(); })}>إيقاف مؤقت</button>
            )}
            {current.status === "halted" && (
              <button className="btn solid" disabled={busy === "ctl"} onClick={() => confirm("نكمل الحملة؟ تأكد إنك فهمت سبب التوقف وإن جودة الرقم رجعت GREEN.") && run("ctl", async () => { setActive(await post<View>({ op: "control", id: current.id, action: "resume" })); await refresh(); }, "رجعت الحملة للعمل. اضغط تابع الإرسال.")}>استئناف</button>
            )}
            <button className="btn ghost" disabled={busy === "report"} onClick={() => void loadReport(current.id)}>تقرير التسليم</button>
            {LIVE.includes(current.status) && (
              <button className="btn ghost danger" disabled={busy === "ctl"} onClick={() => confirm("إلغاء الحملة نهائياً؟ اللي انرسل ما ينسحب.") && run("ctl", async () => { setDriving(false); setActive(await post<View>({ op: "control", id: current.id, action: "cancel" })); await refresh(); }, "انلغت الحملة")}>إلغاء</button>
            )}
          </div>
        </section>
      )}

      {report && (
        <section className="card">
          <h3>تقرير {report.template.name}</h3>
          <p>
            أُرسلت {report.sent} · وصلت {report.delivered} · انقرأت {report.read} · بانتظار التحديث {report.pending} · فشلت {report.failed} ({(report.failureRate * 100).toFixed(1)}%)
          </p>
          {report.errors.length > 0 && (
            <ul className="list">
              {report.errors.map((e) => (
                <li key={String(e.code)}>
                  <div className="grow"><strong dir="ltr">{e.code ?? "بدون كود"}</strong><span className="sub">{e.meaning ?? ""}</span></div>
                  <span className="tag">{e.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">تحديثات التسليم من Meta تتأخر؛ الأرقام تزيد بعد آخر رسالة.</p>
        </section>
      )}

      <div className="kb-grid">
        <div className="stack">
          <section className="card">
            <h3>حملة جديدة</h3>
            {current && LIVE.includes(current.status) ? (
              <p className="hint">فيه حملة {STATUS[current.status]}؛ أنهها أو ألغِها قبل ما تبدأ ثانية (الحساب يشغّل حملة وحدة في المرة).</p>
            ) : (
              <>
                <label htmlFor="list">1. ملف العملاء (xlsx أو csv، حتى 2,000 صف)</label>
                <input id="list" type="file" accept=".xlsx,.csv" disabled={!!busy} onChange={(e) => { void sendFile(e.target.files); e.target.value = ""; }} />
                <p className="hint">الأعمدة: <code>phone</code> و <code>consent_date</code> (تاريخ التسجيل) ثم <code>var1</code> و <code>var2</code>… لمتغيرات القالب. كل رقم لازم يكون وافق على استقبال رسائلك.</p>
                {busy === "upload" && <div className="skel" style={{ height: 40 }} />}
                {upload && (
                  <div className="note" style={{ margin: "10px 0" }}>
                    <p>
                      <strong>{upload.filename}</strong>: {upload.rows} صف، {upload.paramCount} متغير.
                      {upload.warnings.map((w) => <span key={w} className="hint"> {w}</span>)}
                    </p>
                    <p className="hint" dir="ltr">{upload.sample.map((s) => `#${s.sourceRow} ${s.phone} ${s.consentAt.slice(0, 10)}`).join("  |  ")}</p>
                  </div>
                )}

                {upload && (
                  <>
                    <label htmlFor="tpl">2. القالب (المعتمد من فئة تسويق فقط)</label>
                    <select id="tpl" value={tplKey} onChange={(e) => { setTplKey(e.target.value); setDry(null); }}>
                      <option value="">اختر قالباً</option>
                      {usable.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>)}
                    </select>
                    {usable.length === 0 && <p className="hint">ما عندك قالب تسويقي معتمد بعد. أنشئ واحداً من اليمين وانتظر اعتماد Meta.</p>}
                    <button className="btn solid" style={{ marginTop: 12 }} disabled={!!busy || !tplKey} onClick={() => run("dry", async () => setDry(await post<DryRun>({ op: "dry_run", uploadId: upload.uploadId, template: tplName, language: tplLang })))}>
                      {busy === "dry" ? "نفحص…" : "3. افحص بدون إرسال"}
                    </button>
                  </>
                )}
              </>
            )}
          </section>

          {dry && (
            <section className="card">
              <h3>نتيجة الفحص <span className={`status ${dry.ok ? "ok" : "error"}`}>{dry.ok ? "جاهزة" : "ما تنفع"}</span></h3>
              <ul className="list">
                {dry.checks.map((c) => (
                  <li key={c.id}>
                    <span className={`status ${c.ok ? "ok" : "error"}`}>{c.ok ? "✓" : "✕"}</span>
                    <div className="grow" dir="ltr" style={{ textAlign: "start" }}>{c.message}</div>
                  </li>
                ))}
              </ul>
              <p>
                من {dry.summary.total} صف: <strong>{dry.summary.accepted}</strong> يُرسل لهم، <strong>{dry.summary.blocked}</strong> محجوبين. المتبقي من السقف اليومي: {dry.summary.remainingCapacity}.
              </p>
              {dry.blocked.length > 0 && (
                <div className="table-scroll">
                  <table className="logtable">
                    <thead><tr><th>الصف</th><th>السبب</th></tr></thead>
                    <tbody>
                      {dry.blocked.slice(0, 50).map((b, i) => <tr key={i}><td dir="ltr">{b.sourceRow ?? "—"}</td><td>{REASON[b.reason] ?? b.reason}</td></tr>)}
                    </tbody>
                  </table>
                  {(dry.blocked.length > 50 || dry.blockedTruncated) && <p className="hint">نعرض أول 50 فقط. الملخص أعلاه يشمل الكل.</p>}
                </div>
              )}
              {dry.ok && dry.campaignId && dry.confirmToken && (
                <>
                  <p className="note">هذي رسائل حقيقية تنرسل لعملائك وتُحاسب من Meta. أول {dry.pilotSize} رسائل دفعة تجريبية، وبعدها ننتظر دقيقة قبل الباقي.</p>
                  <button
                    className="btn solid"
                    disabled={!!busy}
                    onClick={() =>
                      confirm(`نبدأ حملة "${tplName}" لـ ${dry.summary.accepted} عميل؟`) &&
                      run("start", async () => {
                        const v = await post<View>({ op: "start", id: dry.campaignId, token: dry.confirmToken });
                        setActive(v);
                        setDry(null);
                        setUpload(null);
                        await refresh();
                        setDriving(true);
                      })
                    }
                  >
                    {busy === "start" ? "نبدأ…" : "ابدأ الحملة"}
                  </button>
                </>
              )}
            </section>
          )}
        </div>

        <div className="stack">
          <section className="card">
            <h3>القوالب</h3>
            {data && !data.templates.ok && <p className="err">ما قدرنا نجلب القوالب: {data.templates.error}</p>}
            <ul className="list">
              {(data?.templates.data ?? []).map((t) => (
                <li key={`${t.name}|${t.language}`}>
                  <div className="grow"><strong dir="ltr">{t.name}</strong><span className="sub">{t.language} · {t.category}</span></div>
                  <span className={`status ${tone(t.status)}`}>{t.status}</span>
                </li>
              ))}
            </ul>
            {data?.templates.ok && !data.templates.data?.length && <State title="ما فيه قوالب بعد">أنشئ قالباً تسويقياً من النموذج تحت.</State>}
          </section>

          <section className="card">
            <h3>قالب جديد</h3>
            <p className="hint">نفحصه بقواعد Meta قبل ما نرسله. الاعتماد قرار Meta (دقائق إلى يوم)، والفحص النظيف ما يضمنه.</p>
            <p className="label">قوالب جاهزة لزيادة</p>
            <div className="actions" style={{ flexWrap: "wrap", marginBottom: 12 }}>
              {SUGGESTED_TEMPLATES.map((t) => (
                <button key={t.name} type="button" className="btn ghost small" disabled={!!busy} onClick={() => run("suggest", () => fillSuggested(t))}>{t.title}</button>
              ))}
            </div>
            <select aria-label="الفئة" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as "MARKETING" | "UTILITY", optOut: e.target.value === "MARKETING" })}>
              <option value="MARKETING">تسويق: عروض وإعلانات (يحتاج موافقة العميل)</option>
              <option value="UTILITY">خدمات: متابعة طلب أو استفسار للعميل</option>
            </select>
            <div className="grid2">
              <input dir="ltr" aria-label="اسم القالب" placeholder="summer_offer" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <select aria-label="اللغة" value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}>
                <option value="ar">العربية (ar)</option>
                <option value="en">English (en)</option>
              </select>
            </div>
            {headerImg ? (
              <div className="quote">
                رأس القالب صورة: {headerImg.name} <button type="button" className="tag" onClick={() => setHeaderImg(null)}>×</button>
              </div>
            ) : (
              <div className="grid2">
                <input aria-label="العنوان (اختياري)" placeholder="العنوان (اختياري، نص عادي بدون إيموجي)" value={draft.header} onChange={(e) => setDraft({ ...draft, header: e.target.value })} />
                <label className="btn ghost small">
                  أو صورة للرأس (JPG أو PNG)
                  <input type="file" hidden accept="image/jpeg,image/png" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) f.size > 5 * 1024 * 1024 ? setMsg({ ok: false, text: "الصورة أكبر من 5 ميقا." }) : setHeaderImg(f); }} />
                </label>
              </div>
            )}
            <textarea aria-label="نص الرسالة" rows={5} placeholder="هلا {{1}}، عندنا عرض خاص لك… استخدم الكود {{2}} عند الدفع." value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            {vars > 0 && <p className="hint">كل {"{{رقم}}"} في النص متغير تعبيه وقت الإرسال (مثل اسم العميل). Meta تطلب مثال لكل متغير عشان تراجع القالب بس، والمثال ما يوصل لأي عميل.</p>}
            {Array.from({ length: vars }, (_, i) => (
              <input key={i} aria-label={`مثال للمتغير ${i + 1}`} placeholder={`مثال للمتغير {{${i + 1}}}`} value={draft.examples[i] ?? ""} onChange={(e) => { const ex = [...draft.examples]; ex[i] = e.target.value; setDraft({ ...draft, examples: ex }); }} />
            ))}
            <input aria-label="التذييل (اختياري)" placeholder="التذييل (اختياري)" value={draft.footer} onChange={(e) => setDraft({ ...draft, footer: e.target.value })} />
            <label className="check"><input type="checkbox" checked={draft.optOut} onChange={(e) => setDraft({ ...draft, optOut: e.target.checked })} /> زر "إيقاف" لإلغاء الاشتراك (موصى به جداً)</label>
            <div className="grid2">
              <input aria-label="نص زر الرابط" placeholder="نص زر الرابط (اختياري)" value={draft.urlText} onChange={(e) => setDraft({ ...draft, urlText: e.target.value })} />
              <input dir="ltr" aria-label="رابط الزر" placeholder="https://example.com/shop" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn ghost" disabled={!!busy || !draft.name || !draft.body} onClick={() => run("tplcheck", async () => setTplResult(await post<TplResult>({ op: "template", draft: buildDraft(), submit: false, headerUpload: headerImg ? "check" : undefined })))}>{busy === "tplcheck" ? "نفحص…" : "افحص فقط"}</button>
              <button
                className="btn solid"
                disabled={!!busy || !draft.name || !draft.body}
                onClick={() =>
                  confirm("نرسل القالب لـ Meta للمراجعة؟") &&
                  run("tplsubmit", async () => {
                    const headerUpload = headerImg ? await uploadPieces(secret, headerImg, headerImg.name) : undefined;
                    const r = await post<TplResult>({ op: "template", draft: buildDraft(), submit: true, headerUpload });
                    setTplResult(r);
                    if (r.ok) {
                      setDraft(emptyDraft);
                      setHeaderImg(null);
                      await refresh();
                    }
                  })
                }
              >
                {busy === "tplsubmit" ? "نرسل…" : "أرسل للمراجعة"}
              </button>
            </div>
            {tplResult && (
              <div style={{ marginTop: 12 }}>
                {tplResult.ok ? (
                  <p className="banner ok" role="status">{tplResult.submitted ? `انرسل لـ Meta (${tplResult.meta?.status ?? "PENDING"}). تابع حالته في القائمة فوق.` : "الفحص نظيف، ما انرسل شي."}</p>
                ) : (
                  <p className="banner bad" role="alert">ما نقدر نرسله قبل ما تصلح الأخطاء:</p>
                )}
                <ul className="list">
                  {(tplResult.ok ? tplResult.warnings : tplResult.issues).map((i, k) => (
                    <li key={k}>
                      <span className={`status ${i.level === "error" ? "error" : "draft"}`}>{i.level === "error" ? "خطأ" : "تنبيه"}</span>
                      <div className="grow" dir="ltr" style={{ textAlign: "start" }}><strong>{i.field}</strong> {i.message}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="card">
            <h3>الحملات السابقة</h3>
            {!data && <div className="skel" style={{ height: 80 }} />}
            {data?.campaigns.length === 0 && <State title="ما فيه حملات بعد">ارفع ملف عملاء وافحصه لتبدأ.</State>}
            <ul className="list">
              {data?.campaigns.map((c) => (
                <li key={c.id}>
                  <div className="grow"><strong dir="ltr">{c.template.name}</strong><span className="sub">{c.sent} أُرسلت · {c.failed} فشلت · من {c.total}</span></div>
                  <span className={`status ${tone(c.status)}`}>{STATUS[c.status] ?? c.status}</span>
                  <button className="btn ghost small" disabled={busy === "report"} onClick={() => void loadReport(c.id)}>تقرير</button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
