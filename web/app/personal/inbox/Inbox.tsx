"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { call, errMsg, invalidate, uploadPieces, useApi, useSession, type Status } from "../shared";
import { mediaKind, mediaProblem } from "@/lib/media";
import { Select } from "../Select";

type Chat = { waId: string; name?: string; lastAt: number; last?: { text: string; direction: "in" | "out"; type: string }; group: boolean; windowOpen?: boolean; tags: string[]; drafts: number };
type Msg = { id: string; waId: string; direction: "in" | "out"; type: string; text?: string; caption?: string; filename?: string; timestamp: number; status?: string; replyTo?: string; sender?: string; senderName?: string; reaction?: { emoji: string } };
type Account = { id: string; label: string; kind: "personal" | "official" };
type Draft = { id: string; account: string; accountLabel?: string; flowName: string; chat: string; chatName?: string; text: string; replyTo?: string; about?: { id: string; text?: string; who?: string }; createdAt: number };

const EMOJIS = ["👍", "❤️", "😂", "🙏", "✅"];
const initial = (s: string) => [...s.replace(/^\+/, "").trim()][0] ?? "؟";
const label = (c: { waId: string; name?: string }) => c.name || (c.waId.endsWith("@g.us") ? "مجموعة" : /^\d/.test(c.waId) ? "+" + c.waId.split("@")[0] : c.waId);

function short(sec: number) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("ar", { day: "numeric", month: "short" });
}

type Thread = { name?: string; tags: string[]; messages: Msg[]; window?: { windowOpen: boolean } };

export function Inbox() {
  const { secret, status } = useSession();
  return <App secret={secret} status={status} />;
}

function App({ secret, status }: { secret: string; status: Status }) {
  // The official number is the live one when it is set up; personal numbers stay one pick away.
  const [account, setAccount] = useState(status.official ? "official" : "main");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<"chats" | "drafts">("chats");
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [newTo, setNewTo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [bf, setBf] = useState<{ running: boolean; line: string }>({ running: false, line: "" });
  const stopBf = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Cached and polled gently: the cache refreshes whenever a sync, flow or MCP call stores something.
  const chatsApi = useApi<{ chats: Chat[]; accounts: Account[]; kind: "personal" | "official" }>(`/api/personal/inbox?account=${account}&q=${encodeURIComponent(dq)}`, { fresh: 10_000, poll: 20_000 });
  const draftsApi = useApi<{ drafts: Draft[] }>("/api/personal/drafts", { poll: 20_000 });
  const threadApi = useApi<Thread>(active ? `/api/personal/inbox?account=${account}&view=messages&chat=${encodeURIComponent(active)}` : null, { fresh: 5_000, poll: 20_000 });
  const chats = chatsApi.data?.chats ?? [];
  const accounts = chatsApi.data?.accounts ?? status.accounts.map((a): Account => ({ id: a.id, label: a.label, kind: "personal" }));
  const kind = chatsApi.data?.kind ?? "personal";
  const drafts = draftsApi.data?.drafts ?? [];
  const thread = threadApi.data ?? null;

  const say = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? "" : x)), 4000);
  }, []);

  const loadChats = useCallback(async () => {
    await Promise.all([chatsApi.reload(), draftsApi.reload()]);
  }, [chatsApi.reload, draftsApi.reload]);
  const loadThread = (_chat?: string) => threadApi.reload();

  useEffect(() => {
    if (chatsApi.error) say(chatsApi.error);
  }, [chatsApi.error, say]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, active]);

  const act = async (what: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(what);
    try {
      await fn();
      if (okText) say(okText);
    } catch (e) {
      say(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const to = active ?? newTo;
    const body = text.trim();
    const attach = active ? file : null;
    if ((!body && !attach) || !to) return;
    const reply = replyTo;
    // Show the message at once; the server answer replaces it, a failure puts the text back.
    if (active) {
      threadApi.set((prev) => ({
        ...(prev ?? { tags: [], messages: [] }),
        messages: [...(prev?.messages ?? []), { id: `tmp-${Date.now()}`, waId: to, direction: "out", type: attach ? mediaKind(attach.type) ?? "document" : "text", ...(attach ? { caption: body, filename: attach.name } : { text: body }), timestamp: Math.floor(Date.now() / 1000), status: "sending", replyTo: reply?.id }],
      }));
    }
    setText("");
    setReplyTo(null);
    setFile(null);
    stick.current = true;
    setBusy("send");
    try {
      if (attach) {
        setProgress(1);
        const id = await uploadPieces(secret, attach, attach.name, setProgress);
        await call(secret, "/api/personal/inbox", { body: { op: "media", account, chat: to, text: body, replyTo: reply?.id, upload: id } });
      } else {
        await call(secret, "/api/personal/inbox", { body: { op: "send", account, chat: to, text: body, replyTo: reply?.id } });
      }
      invalidate("/api/personal/inbox");
      if (!active) setNewTo("");
      await Promise.all([loadChats(), active ? loadThread(active) : undefined]);
    } catch (err) {
      setText(body);
      setReplyTo(reply);
      if (attach) setFile(attach);
      say(errMsg(err));
      if (active) await loadThread(active);
    } finally {
      setBusy("");
      setProgress(0);
    }
  };

  useEffect(() => (setFile(null), setTplOpen(false)), [active, account]);
  const afterTemplate = async () => {
    setTplOpen(false);
    say("انرسل القالب");
    invalidate("/api/personal/inbox");
    if (!active) setNewTo("");
    await Promise.all([loadChats(), active ? loadThread(active) : undefined]);
  };

  const pickFile = (f: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    const problem = mediaProblem(f.type, f.size);
    if (problem) return say(problem);
    setFile(f);
  };

  const sync = () =>
    act("sync", async () => {
      const d = await call<{ newMessages: number }>(secret, "/api/personal/inbox", { body: { op: "sync", account } });
      await loadChats();
      if (active) await loadThread(active);
      say(kind === "official" ? "الرقم الرسمي يوصله كل شي لحظياً من Meta" : `تمت المزامنة، ${d.newMessages} رسالة جديدة`);
    });

  // Each call fetches a slice (under two minutes); we keep calling until the phone has nothing older.
  const backfill = async (reset = false) => {
    stopBf.current = false;
    setBf({ running: true, line: "أطلب الرسائل الأقدم من الجوال… خلّ الجوال متصل بالإنترنت" });
    try {
      for (let first = true; ; first = false) {
        const r = await call<{ finished: boolean; left: number; chats: number; added: number }>(secret, "/api/personal/inbox", { body: { op: "backfill", account, reset: reset && first } });
        setBf({ running: !r.finished && !stopBf.current, line: r.finished ? `اكتمل: ${r.added} رسالة قديمة جُلبت من ${r.chats} محادثة` : `جاري الجلب… بقي ${r.left} من ${r.chats} محادثة (جُلب ${r.added} رسالة)` });
        await loadChats();
        if (r.finished || stopBf.current) break;
      }
    } catch (e) {
      setBf({ running: false, line: e instanceof Error ? e.message : "تعذّر الجلب، أعد المحاولة وهو يكمل من حيث وقف" });
    }
    setBf((x) => ({ ...x, running: false }));
  };

  const react = (m: Msg, emoji: string) => act("react", () => call(secret, "/api/personal/inbox", { body: { op: "react", account, chat: m.waId, messageId: m.id, emoji } }), "تم التفاعل");
  const markRead = () => active && act("read", () => call(secret, "/api/personal/inbox", { body: { op: "read", account, chat: active } }), "تم تعليمها كمقروءة");
  const tagOp = (t: string, remove = false) =>
    active &&
    act("tag", async () => {
      await call(secret, "/api/personal/inbox", { body: { op: "tag", account, chat: active, tag: t, remove } });
      setTag("");
      await Promise.all([loadThread(active), loadChats()]);
    });

  const decide = (d: Draft, action: "approve" | "reject", edited: string) =>
    act(
      "draft",
      async () => {
        await call(secret, "/api/personal/drafts", { body: { account: d.account, id: d.id, action, text: edited } });
        await loadChats();
        if (active) await loadThread(active);
      },
      action === "approve" ? "أُرسلت" : "تم التجاهل",
    );

  const here = drafts.filter((d) => d.account === account && d.chat === active);
  const pending = drafts.length;
  const open = !!active;
  const msgById = new Map((thread?.messages ?? []).map((m) => [m.id, m]));

  return (
    <>
      <div className={`inbox${open && tab === "chats" ? " show-thread" : ""}`}>
        <aside className="side">
          <div className="tools">
            <Select aria-label="الرقم" value={account} onChange={(e) => (setAccount(e.target.value), setActive(null))}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </Select>
            <input aria-label="بحث" placeholder="ابحث بالاسم أو الرقم" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="seg" role="group" aria-label="القائمة">
              <button type="button" aria-pressed={tab === "chats"} onClick={() => setTab("chats")}>المحادثات</button>
              <button type="button" aria-pressed={tab === "drafts"} onClick={() => setTab("drafts")}>المسودات{pending ? ` (${pending})` : ""}</button>
            </div>
            <div className="row">
              <button type="button" className="btn small ghost" onClick={sync} disabled={busy === "sync"}>{busy === "sync" ? "…" : "زامن"}</button>
              {kind === "personal" && (bf.running
                ? <button type="button" className="btn small ghost" onClick={() => { stopBf.current = true; }}>إيقاف الجلب</button>
                : <button type="button" className="btn small ghost" onClick={() => backfill()} title="يجلب الرسائل الأقدم من الجوال على دفعات">اجلب التاريخ القديم</button>)}
            </div>
            {bf.line && <p className="hint" style={{ margin: "6px 0 0" }}>{bf.line}</p>}
          </div>
          {tab === "chats" ? (
            <ul className="chatlist">
              {!chatsApi.data && Array.from({ length: 7 }, (_, i) => <li key={i} style={{ padding: "14px 16px" }}><div className="skel" style={{ height: 44 }} /></li>)}
              {chatsApi.data && chats.length === 0 && <li className="empty">ما فيه محادثات محفوظة بعد. اضغط "زامن" أو انتظر رسالة جديدة.</li>}
              {chats.map((c) => (
                <li key={c.waId}>
                  <button type="button" aria-current={active === c.waId} onClick={() => (stick.current = true, setActive(c.waId), setTab("chats"))}>
                    <span className="av" aria-hidden="true">{initial(label(c))}</span>
                    <span className="cbody">
                      <span className="top">
                        <span className="nm">{label(c)}{c.drafts ? <span className="badge">{c.drafts}</span> : null}</span>
                        <span className="tm">{short(c.lastAt)}</span>
                      </span>
                      <span className="pv">{c.last ? `${c.last.direction === "out" ? "أنت: " : ""}${c.last.text}` : ""}</span>
                      {c.tags.length > 0 && <span className="ctags">{c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="chatlist">
              {drafts.length === 0 && <li className="empty">ما فيه مسودات تنتظر موافقتك.</li>}
              {drafts.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => (setAccount(d.account), setActive(d.chat), setTab("chats"))}>
                    <span className="av" aria-hidden="true">{initial(d.chatName || d.chat.split("@")[0])}</span>
                    <span className="cbody">
                      <span className="top"><span className="nm">{d.chatName || "+" + d.chat.split("@")[0]}</span><span className="tm">{short(d.createdAt / 1000)}</span></span>
                      <span className="pv">{d.text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="thread" aria-label="المحادثة">
          {!open ? (
            <div className="empty">
              <p>اختر محادثة من القائمة، أو ابدأ محادثة جديدة.</p>
              <form onSubmit={send} className="newchat">
                <h4>محادثة جديدة</h4>
                <label className="muted small" htmlFor="newchat-to">الرقم مع رمز الدولة</label>
                <input id="newchat-to" dir="ltr" inputMode="tel" placeholder="966501234567" value={newTo} onChange={(e) => setNewTo(e.target.value)} />
                <label className="muted small" htmlFor="newchat-text">الرسالة</label>
                <textarea id="newchat-text" placeholder="اكتب رسالتك…" value={text} onChange={(e) => setText(e.target.value)} />
                <button className="btn solid" disabled={!newTo || !text.trim() || busy === "send"}>{busy === "send" ? "يرسل…" : "أرسل"}</button>
              </form>
              {kind === "official" && (
                <>
                  <p className="hint">الرقم الرسمي يرسل نص حر فقط خلال 24 ساعة من آخر رسالة للعميل. لعميل جديد أو نافذة مسكرة استخدم قالب.</p>
                  <button type="button" className="btn ghost small" onClick={() => setTplOpen((x) => !x)}>📄 {tplOpen ? "إخفاء القوالب" : "أرسل قالب"}</button>
                  {tplOpen && <TemplatePanel secret={secret} account={account} to={newTo.replace(/\D/g, "")} onSent={afterTemplate} onError={say} />}
                </>
              )}
            </div>
          ) : (
            <>
              <header>
                <button type="button" className="btn ghost small only-narrow" onClick={() => setActive(null)}>← رجوع</button>
                <h4>{thread?.name || label({ waId: active!, name: chats.find((c) => c.waId === active)?.name })}</h4>
                {(thread?.tags ?? []).map((t) => (
                  <button key={t} type="button" className="tag" title="اضغط لحذف الوسم" onClick={() => tagOp(t, true)}>{t} ×</button>
                ))}
                <input aria-label="وسم جديد" placeholder="وسم +" value={tag} style={{ width: 90, padding: "4px 10px" }} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tag.trim() && tagOp(tag.trim())} />
                <button type="button" className="btn ghost small" onClick={markRead} disabled={busy === "read"}>تعليم كمقروء</button>
              </header>
              <div className="msgs" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
                {(thread?.messages ?? []).filter((m) => m.type !== "reaction").map((m) => {
                  const quoted = m.replyTo ? msgById.get(m.replyTo) : undefined;
                  const body = m.text ?? m.caption ?? "";
                  return (
                    <div key={m.id} className={`m ${m.direction}`}>
                      {m.direction === "in" && active!.endsWith("@g.us") && <div className="who">{m.senderName || (m.sender ? "+" + m.sender : "")}</div>}
                      {quoted && <div className="quote">{(quoted.text ?? quoted.caption ?? `[${quoted.type}]`).slice(0, 120)}</div>}
                      {body}
                      {["image", "video", "audio", "document", "sticker"].includes(m.type) && (
                        <div className="muted">
                          [{m.type}{m.filename ? `: ${m.filename}` : ""}]
                        </div>
                      )}
                      <div className="meta">
                        <time>{new Date(m.timestamp * 1000).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</time>
                        {m.direction === "out" && m.status && <span>{m.status === "read" ? "✓✓ قُرئت" : m.status === "delivered" ? "✓✓" : m.status === "failed" ? "فشل" : m.status === "sending" ? "…" : "✓"}</span>}
                        <span className="acts">
                          <button type="button" title="رد" onClick={() => setReplyTo(m)}>↩</button>
                          {EMOJIS.map((e) => <button type="button" key={e} title={`تفاعل ${e}`} onClick={() => react(m, e)}>{e}</button>)}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {!thread && <div className="skel" style={{ height: 120 }} />}
                <div ref={bottom} />
              </div>
              {here.length > 0 && (
                <div className="drafts" aria-label="مسودات تنتظر موافقتك">
                  {here.map((d) => (
                    <DraftCard key={d.id} d={d} busy={busy === "draft"} onDecide={decide} />
                  ))}
                </div>
              )}
              <form className="composer" onSubmit={send}>
                {replyTo && (
                  <div className="quote">
                    ردّ على: {(replyTo.text ?? replyTo.caption ?? `[${replyTo.type}]`).slice(0, 100)} <button type="button" className="tag" onClick={() => setReplyTo(null)}>×</button>
                  </div>
                )}
                {kind === "official" && thread?.window && !thread.window.windowOpen && <p className="hint">انتهت نافذة الـ 24 ساعة لهذا العميل، الإرسال الحر ما يشتغل. اضغط "📄 قالب" تحت.</p>}
                <textarea
                  aria-label="الرسالة"
                  placeholder="اكتب رسالة… (Enter للإرسال، Shift+Enter لسطر جديد)"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                {tplOpen && kind === "official" && <TemplatePanel secret={secret} account={account} to={active!} onSent={afterTemplate} onError={say} />}
                {file && (
                  <div className="quote">
                    مرفق: {file.name} ({(file.size / 1024 / 1024).toFixed(1)} ميقا){text.trim() ? "، والنص يروح تعليق عليه" : ""} <button type="button" className="tag" onClick={() => setFile(null)}>×</button>
                  </div>
                )}
                <div className="row">
                  {kind === "official" && (
                    <>
                      <input ref={fileInput} type="file" hidden accept=".jpg,.jpeg,.png,.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(e) => pickFile(e.target.files?.[0])} />
                      <button type="button" className="btn ghost small" title="إرفاق صورة أو ملف" onClick={() => fileInput.current?.click()} disabled={busy === "send"}>📎 إرفاق</button>
                      <button type="button" className="btn ghost small" title="رسالة من قالب معتمد" onClick={() => setTplOpen((x) => !x)}>📄 قالب</button>
                    </>
                  )}
                  <span className="hint">{busy === "send" ? (progress > 0 && progress < 100 ? `يرفع الملف… ${progress}%` : "يرسل… قد ياخذ بضع ثواني") : "تنرسل من رقمك الحقيقي فوراً"}</span>
                  <button className="btn solid" disabled={(!text.trim() && !file) || busy === "send"}>أرسل</button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

type Tpl = { name: string; language: string; category: string; body: string; params: number; header: "IMAGE" | "TEXT" | null; headerText?: string };

/** Picks an approved template, fills its variables (and header image) and sends it after a cost check. */
function TemplatePanel({ secret, account, to, onSent, onError }: { secret: string; account: string; to: string; onSent: () => Promise<void>; onError: (m: string) => void }) {
  const api = useApi<{ templates: Tpl[] }>(`/api/personal/inbox?account=${account}&view=templates`, { fresh: 60_000 });
  const [key, setKey] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [img, setImg] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const list = api.data?.templates ?? [];
  const t = list.find((x) => `${x.name}|${x.language}` === key);
  const preview = t ? t.body.replace(/\{\{(\d+)\}\}/g, (m, n) => params[Number(n) - 1] || m) : "";
  const ready = !!t && !!to && params.slice(0, t.params).filter((x) => x.trim()).length === t.params && (t.header !== "IMAGE" || !!img);

  const send = async () => {
    if (!t) return;
    const kind = t.category === "MARKETING" ? "تسويقية" : t.category === "UTILITY" ? "خدمات" : t.category;
    if (!confirm(`نرسل قالب "${t.name}" لـ ${to}؟ هذي رسالة ${kind} وMeta تحاسب عليها.`)) return;
    setBusy(true);
    try {
      const headerUpload = img ? await uploadPieces(secret, img, img.name) : undefined;
      await call(secret, "/api/personal/inbox", { body: { op: "template", account, chat: to, name: t.name, language: t.language, params: params.slice(0, t.params), body: t.body, headerUpload } });
      setKey("");
      setParams([]);
      setImg(null);
      await onSent();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tplpanel" style={{ display: "grid", gap: 8, marginBottom: 8 }}>
      {api.error && <p className="err small">{api.error}</p>}
      {!api.error && api.data && !list.length && <p className="hint">ما فيه قوالب معتمدة بعد. أنشئها من صفحة الحملات.</p>}
      <Select aria-label="القالب" value={key} onChange={(e) => (setKey(e.target.value), setParams([]), setImg(null))}>
        <option value="">اختر قالباً معتمداً…</option>
        {list.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name} ({x.language}){x.header === "IMAGE" ? " · صورة" : ""}</option>)}
      </Select>
      {t && (
        <>
          {t.header === "IMAGE" && (
            <label className="btn ghost small">
              {img ? `صورة الرأس: ${img.name}` : "اختر صورة الرأس (JPG أو PNG، أقل من 5 ميقا)"}
              <input type="file" hidden accept="image/jpeg,image/png" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) f.size > 5 * 1024 * 1024 ? onError("الصورة أكبر من 5 ميقا.") : setImg(f); }} />
            </label>
          )}
          {Array.from({ length: t.params }, (_, i) => (
            <input key={i} aria-label={`المتغير ${i + 1}`} placeholder={`قيمة {{${i + 1}}}`} value={params[i] ?? ""} onChange={(e) => { const p = [...params]; p[i] = e.target.value; setParams(p); }} />
          ))}
          <div className="quote" style={{ whiteSpace: "pre-wrap" }}>{t.headerText ? `${t.headerText}\n` : ""}{preview}</div>
          <button type="button" className="btn solid" disabled={!ready || busy} onClick={send}>{busy ? "يرسل…" : "أرسل القالب"}</button>
        </>
      )}
    </div>
  );
}

function DraftCard({ d, busy, onDecide }: { d: Draft; busy: boolean; onDecide: (d: Draft, a: "approve" | "reject", t: string) => void }) {
  const [t, setT] = useState(d.text);
  return (
    <div className="draft">
      <p className="about">مسودة من الفلو "{d.flowName}"{d.about?.text ? ` · ردّاً على: ${d.about.text.slice(0, 80)}` : ""}</p>
      <textarea aria-label="نص المسودة" value={t} onChange={(e) => setT(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn solid small" disabled={busy || !t.trim()} onClick={() => onDecide(d, "approve", t)}>أرسل</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => onDecide(d, "reject", t)}>تجاهل</button>
      </div>
    </div>
  );
}
