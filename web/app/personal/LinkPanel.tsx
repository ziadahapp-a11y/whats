"use client";

import { useState } from "react";
import { reportUrl } from "@/lib/version";
import { call, errMsg, invalidate, phoneOf, useApi, useCopy, useSession, when, type Status } from "./shared";

type Key = { id: string; label: string; accounts: string[] | "*"; scope: "read" | "full"; createdAt: number; lastUsed?: number };
type Created = { token: string; url: string; label: string; accounts: string[] | "*"; scope: "read" | "full" };

export function LinkPanel({ origin }: { origin: string }) {
  const { secret, status, reload } = useSession();
  return <Home secret={secret} status={status} reload={reload} origin={origin} />;
}

function Home({ secret, status, reload, origin }: { secret: string; status: Status; reload: () => Promise<void>; origin: string }) {
  return (
    <>
      <div className="chips">
        <Chip ok={status.storage} label="قاعدة البيانات (Redis)" />
        <Chip ok={status.cron} label="المزامنة اليومية (CRON_SECRET)" />
        <Chip ok={status.ai} label="الذكاء الاصطناعي" optional />
        <Chip ok={status.official} label="الرقم الرسمي (Cloud API)" optional />
      </div>
      {status.secretWarning && <div className="note"><p><strong>تنبيه على كلمة السر:</strong> {status.secretWarning} لا تستخدمها داخل الروابط، وأنشئ مفتاح جهاز (wmk_…) للربط بدلها.</p></div>}
      <AiTest secret={secret} configured={status.ai} />
      {!status.storage && <div className="note"><p>اربط Upstash Redis من تبويب Storage في مشروعك على فيرسل، ثم أعد النشر. بدونها ما يمكن حفظ الجلسة.</p></div>}

      <h3>أرقامك</h3>
      <p className="muted">كل رقم يرتبط كجهاز مستقل، وله رسائله وفلواته. تقدر تضيف أكثر من رقم لك.</p>
      <Numbers secret={secret} status={status} reload={reload} />

      <h3 style={{ marginTop: 40 }}>اربطها بمساعدك</h3>
      <p className="muted">
        لكل جهاز أو شخص مفتاح خاص فيه رابط جاهز. تلصق الرابط في إعدادات المساعد وخلاص، بدون هيدرات. تقدر تحدد له أرقام معينة، أو تخليه للقراءة فقط، وتلغيه متى ما بغيت بدون ما يتأثر الباقي.
      </p>
      <Keys secret={secret} status={status} origin={origin} />

      <h3 style={{ marginTop: 40 }}>النسخة والملاحظات</h3>
      <p className="muted">
        نسختك: <code dir="ltr">{status.version?.commit ?? "غير معروفة"}</code>. لو واجهت خطأ أو بغيت ميزة، اضغط الزر وراح يفتح لك بلاغ جاهز فيه رقم النسخة وحالة الإعدادات (بدون أي مفتاح أو رسالة).
      </p>
      <a className="btn ghost" target="_blank" rel="noopener noreferrer" href={reportUrl(status.version ?? { repo: null, commit: null, branch: null, env: "?" }, { "قاعدة البيانات": status.storage, "المزامنة المجدولة": status.cron, "الذكاء الاصطناعي": status.ai, "الرقم الرسمي": status.official, "أرقام مربوطة": String(status.accounts.filter((a) => a.paired).length) }, origin)}>أرسل ملاحظة أو بلاغ خطأ</a>
    </>
  );
}

function AiTest({ secret, configured }: { secret: string; configured: boolean }) {
  const [out, setOut] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await call<{ results: { provider: string; ok: boolean; detail: string }[] }>(secret, "/api/personal/ai-test", { method: "POST", body: {} });
      setOut(r.results.map((x) => `${x.provider === "cheap" ? "المزود الرخيص" : "Claude"}: ${x.ok ? "✓ يشتغل" : "✗ " + x.detail}`));
    } catch (e) {
      setOut([errMsg(e)]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <p>
      <button type="button" className="btn ghost" disabled={busy} onClick={run}>{busy ? "جاري الاختبار…" : "اختبر الذكاء الاصطناعي"}</button>
      {!configured && <small> ما فيه مفتاح، شوف <a href="/guide#s3">الخطوات</a>.</small>}
      {out.map((l) => <span key={l} className="muted" style={{ display: "block" }}>{l}</span>)}
    </p>
  );
}

function Chip({ ok, label, optional }: { ok: boolean; label: string; optional?: boolean }) {
  return (
    <span className={`chip ${ok ? "on" : optional ? "opt" : "off"}`}>
      <span aria-hidden="true">{ok ? "✓" : optional ? "○" : "✗"}</span> {label}
    </span>
  );
}

// ---------- numbers ----------

function Numbers({ secret, status, reload }: { secret: string; status: Status; reload: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(status.accounts.find((a) => !a.paired)?.id ?? null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const { account } = await call<{ account: { id: string } }>(secret, "/api/personal/accounts", { body: { label } });
      setLabel("");
      await reload();
      setOpen(account.id);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function unlink(id: string) {
    if (!confirm("فصل هذا الرقم من واتساب وحذف جلسته؟ رسائله المحفوظة تبقى.")) return;
    await call(secret, "/api/personal/unlink", { body: { account: id } }).catch((e) => setError(errMsg(e)));
    await reload();
  }

  async function remove(id: string) {
    if (!confirm("حذف الرقم نهائياً مع كل رسائله وفلواته المحفوظة؟")) return;
    await call(secret, `/api/personal/accounts?id=${id}`, { method: "DELETE" }).catch((e) => setError(errMsg(e)));
    await reload();
  }

  return (
    <div className="cards">
      {status.accounts.map((a) => (
        <div className="card" key={a.id}>
          <div className="card-head">
            <strong>{a.label}</strong>
            <code>{a.id}</code>
            {a.paired ? <span className="chip on">مربوط {phoneOf(a.me)}</span> : <span className="chip off">غير مربوط</span>}
          </div>
          {a.paired ? (
            <>
              <p className="muted">
                آخر مزامنة: {when(a.lastSync)} · المحادثات المحفوظة: {a.cachedChats}
              </p>
              <div className="row">
                <button className="btn ghost" type="button" onClick={() => unlink(a.id)}>افصل الجهاز</button>
                {a.id !== "main" && <button className="btn ghost" type="button" onClick={() => remove(a.id)}>احذف الرقم</button>}
              </div>
            </>
          ) : open === a.id ? (
            <PairForm secret={secret} account={a.id} onDone={reload} />
          ) : (
            <div className="row">
              <button className="btn solid" type="button" onClick={() => setOpen(a.id)}>اربط هذا الرقم</button>
              {a.id !== "main" && <button className="btn ghost" type="button" onClick={() => remove(a.id)}>احذف</button>}
            </div>
          )}
        </div>
      ))}
      <form className="card add" onSubmit={add}>
        <label htmlFor="newnum">إضافة رقم آخر</label>
        <div className="row">
          <input id="newnum" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="اسم للرقم، مثل: الشغل" maxLength={40} required />
          <button className="btn ghost" type="submit">أضف</button>
        </div>
        {error && <p className="err">{error}</p>}
      </form>
    </div>
  );
}

type Step = "idle" | "requesting" | "code" | "linked" | "done" | "error";

function PairForm({ secret, account, onDone }: { secret: string; account: string; onDone: () => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [code, setCode] = useState("");
  const [history, setHistory] = useState(0);
  const [error, setError] = useState("");

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setStep("requesting");
    setError("");
    setCode("");
    setHistory(0);
    try {
      const r = await fetch("/api/personal/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phone, account }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const ev = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (ev.type === "code") {
            setCode(ev.code);
            setStep("code");
          } else if (ev.type === "linked") setStep("linked");
          else if (ev.type === "history") setHistory(ev.messages);
          else if (ev.type === "done") {
            setHistory(ev.messages);
            setStep("done");
          } else if (ev.type === "error") throw new Error(ev.message);
        }
      }
      await onDone();
    } catch (err) {
      setError(errMsg(err));
      setStep("error");
    }
  }

  return (
    <>
      <form className="phone-form" onSubmit={link}>
        <label htmlFor={`phone-${account}`}>رقم واتساب مع رمز الدولة</label>
        <div className="row">
          <input id={`phone-${account}`} dir="ltr" inputMode="tel" placeholder="966501234567" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <button className="btn solid" type="submit" disabled={step === "requesting" || step === "code" || step === "linked"}>اطلب رمز الربط</button>
        </div>
      </form>
      {step === "requesting" && <p className="muted">نطلب الرمز من واتساب…</p>}
      {step === "code" && (
        <div className="pair-code">
          <p>في جوالك: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف بدلاً من ذلك، واكتب:</p>
          <output dir="ltr">{code}</output>
          <p className="muted">الرمز صالح لدقائق قليلة. خل الصفحة مفتوحة.</p>
        </div>
      )}
      {step === "linked" && <p>تم الربط. نحفظ محادثاتك الأخيرة… {history ? `(${history} رسالة)` : ""}</p>}
      {step === "done" && <p>تم. حفظنا {history} رسالة من السجل.</p>}
      {step === "error" && <p className="err">{error}</p>}
    </>
  );
}

// ---------- device keys ----------

function Keys({ secret, status, origin }: { secret: string; status: Status; origin: string }) {
  const keysApi = useApi<{ keys: Key[] }>("/api/personal/keys", { fresh: 30_000 });
  const keys = keysApi.data?.keys ?? [];
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState("");
  const { copied, copy } = useCopy();

  const load = async () => {
    invalidate("/api/personal/keys");
    await keysApi.reload();
  };

  const names = (k: Key["accounts"]) => (k === "*" ? "كل الأرقام" : k.map((id) => status.accounts.find((a) => a.id === id)?.label ?? id).join("، "));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const accounts = picked.length === 0 || picked.length === status.accounts.length ? "*" : picked;
      const d = await call<{ token: string; url: string }>(secret, "/api/personal/keys", { body: { label, accounts, scope: readOnly ? "read" : "full" } });
      setCreated({ ...d, label, accounts, scope: readOnly ? "read" : "full" });
      setLabel("");
      await load();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function revoke(k: Key) {
    if (!confirm(`إلغاء مفتاح "${k.label}"؟ أي جهاز يستخدمه يتوقف فوراً.`)) return;
    await call(secret, `/api/personal/keys?id=${k.id}`, { method: "DELETE" }).catch((e) => setError(errMsg(e)));
    await load();
  }

  const cliCmd = created ? `claude mcp add --transport http whatsapp "${created.url}"` : "";
  const json = created ? `{ "mcpServers": { "whatsapp": { "type": "http", "url": "${created.url}" } } }` : "";

  return (
    <>
      <form className="card" onSubmit={create}>
        <label htmlFor="keylabel">مفتاح جديد</label>
        <div className="row">
          <input id="keylabel" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="اسم الجهاز، مثل: لابتوب الشغل" maxLength={40} required />
          <button className="btn solid" type="submit">أنشئ المفتاح</button>
        </div>
        <div className="opts">
          {status.accounts.length > 1 && (
            <fieldset>
              <legend>الأرقام المسموحة (بدون اختيار = الكل)</legend>
              {status.accounts.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} /> {a.label}
                </label>
              ))}
            </fieldset>
          )}
          <label className="check">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> للقراءة فقط (ما يقدر يرسل شي)
          </label>
        </div>
        {error && <p className="err">{error}</p>}
      </form>

      {created && (
        <div className="card fresh" role="status">
          <p>
            <strong>مفتاح "{created.label}" جاهز.</strong> هذا الرابط يظهر مرة وحدة، انسخه الحين. كل من عنده الرابط يدخل على {names(created.accounts)} {created.scope === "read" ? "(قراءة فقط)" : ""}.
          </p>
          <p className="label">الرابط (للتطبيقات اللي تطلب رابط فقط)</p>
          <div className="code"><pre dir="ltr">{created.url}</pre><button type="button" className="copy" onClick={() => copy(created.url, "url")}>{copied === "url" ? "تم النسخ" : "انسخ"}</button></div>
          <p className="label">سطر أوامر Claude Code (أمر واحد)</p>
          <div className="code"><pre dir="ltr">{cliCmd}</pre><button type="button" className="copy" onClick={() => copy(cliCmd, "cc")}>{copied === "cc" ? "تم النسخ" : "انسخ"}</button></div>
          <p className="label">Cursor / VS Code / ملف الإعدادات</p>
          <div className="code"><pre dir="ltr">{json}</pre><button type="button" className="copy" onClick={() => copy(json, "js")}>{copied === "js" ? "تم النسخ" : "انسخ"}</button></div>
          <p className="muted">
            في أي تطبيق يدعم MCP (مثل Claude): الإعدادات ← الموصلات ← إضافة موصل مخصص، والصق الرابط (اترك خانة OAuth فاضية). لتثبيت الرابط على رقم واحد أضف <code>&amp;account=رقم_المعرف</code> في آخره.
          </p>
          <button className="btn ghost" type="button" onClick={() => setCreated(null)}>نسخت، اخفِ</button>
        </div>
      )}

      {keys.length > 0 && (
        <table className="compare keys">
          <thead>
            <tr><th>الاسم</th><th>الأرقام</th><th>الصلاحية</th><th>آخر استخدام</th><th /></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td>{names(k.accounts)}</td>
                <td>{k.scope === "read" ? "قراءة" : "قراءة وإرسال"}</td>
                <td>{k.lastUsed ? when(k.lastUsed / 1000) : "لم يُستخدم"}</td>
                <td><button className="btn ghost small" type="button" onClick={() => revoke(k)}>إلغاء</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        مفتاحك الرئيسي (<code>MCP_SECRET</code>) يفتح كل شي ويدخلك هذي اللوحة، فلا تعطيه لأحد. للمفاتيح السريعة بدون لوحة تقدر تضيف <code>MCP_SECRETS</code> في فيرسل (قيم مفصولة بفاصلة)، لكنها بكل الصلاحيات وما تنلغى إلا بحذفها من هناك.
      </p>
    </>
  );
}
