"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { flowToGraph } from "@/lib/flows/graph";
import type { Action, Cond, Graph, LogEntry, Trigger } from "@/lib/flows/types";
import { call, errMsg, useApi, useCopy, useSession } from "../shared";
import { Ctx, Icon, TITLE, nodeTypes, toEdge, toNode, type RunMark } from "./FlowBuilder";
import { ACTION_LABEL, type ActionType } from "./presets";
import { State } from "../State";

type Run = LogEntry & { accountLabel?: string };
type Steps = LogEntry["actions"];
type Replay = { triggered: boolean; matched: boolean; actions: Steps; changed: boolean };
type FlowLite = { id: string; name: string; trigger: Trigger; match: "all" | "any"; conditions: Cond[]; actions: Action[]; graph?: Graph; changed: boolean };

export const STATUS_LABEL: Record<string, string> = { ok: "تم", draft: "مسودة", dry: "تجربة", error: "خطأ", skipped: "تخطّى" };

// the LRM marks keep "12 ms" from being flipped inside right-to-left text
export const fmtMs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `\u200E${ms} ms\u200E` : `\u200E${(ms / 1000).toFixed(1)} s\u200E`);
const stepTitle = (type: string) => (type === "condition" ? "شرط" : TITLE[type as ActionType] ?? type);

const AI_STEPS = new Set(["ai", "ai_reply", "agent"]);
const usesAi = (steps: Steps) => steps.some((s) => AI_STEPS.has(s.type) || s.checks?.some((c) => c.field === "ai"));
const branchOf = (s?: Steps[number]) => (s?.type === "condition" ? s.detail?.split(":")[0] : undefined);
const label = (s?: Steps[number]) => (!s ? "انتهى" : s.type === "condition" ? `شرط (${branchOf(s) === "true" ? "نعم" : "لا"})` : stepTitle(s.type));

/** What differs between the original run and its replay, in plain lines. */
function compare(orig: Steps, rep: Replay): { ok: boolean; text: string }[] {
  const out: { ok: boolean; text: string }[] = [];
  const sig = (s: Steps[number]) => `${s.node ?? ""}|${s.type}|${branchOf(s) ?? ""}`;
  const a = orig.map(sig);
  const b = rep.actions.map(sig);
  const i = a.findIndex((x, k) => x !== b[k]);
  if (a.length === b.length && i < 0) out.push({ ok: true, text: "نفس المسار: مرّت على نفس الخطوات بنفس الترتيب." });
  else {
    const k = i < 0 ? Math.min(a.length, b.length) : i;
    out.push({ ok: false, text: `اختلف المسار عند الخطوة ${k + 1}: في الأصل "${label(orig[k])}" وفي الإعادة "${label(rep.actions[k])}".` });
  }
  const bad = rep.actions.filter((s) => !s.ok);
  if (bad.length) out.push({ ok: false, text: `فشلت ${bad.length} خطوة في الإعادة. أولها: ${bad[0].detail ?? stepTitle(bad[0].type)}` });
  if (!rep.triggered) out.push({ ok: false, text: "المحفز ما ينطبق على الرسالة المحفوظة (اتجاه أو نوع محادثة تغيّر في الفلو)." });
  else if (!rep.matched) out.push({ ok: false, text: "الرسالة ما وصلت لأي إجراء في الإعادة." });
  return out;
}

/** Which node each step belongs to. Graph runs carry it; a linear flow's steps map to its converted nodes by position. */
function marksFor(steps: Steps, graph: Graph | null, linear: boolean) {
  const m = new Map<string, RunMark & { branch?: string }>();
  if (!graph) return m;
  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (trigger) m.set(trigger.id, { ok: true, detail: "المحفز" });
  let action = 0;
  for (const s of steps) {
    const node = s.node ?? (linear && s.type !== "condition" ? `a${++action}` : undefined);
    if (node) m.set(node, { ok: s.ok, detail: s.detail, branch: branchOf(s) });
  }
  if (linear && graph.nodes.some((n) => n.id === "c1")) m.set("c1", { ok: true, detail: "true", branch: "true" });
  return m;
}

export function RunDetail({ id }: { id: string }) {
  const api = useApi<{ run: Run; flow: FlowLite | null }>(`/api/personal/flows?run=${encodeURIComponent(id)}`, { fresh: 10 * 60_000 });
  const { copied, copy } = useCopy();
  const { secret } = useSession();
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState("");
  const [aiChoice, setAiChoice] = useState<boolean | null>(null);
  const [view, setView] = useState<"original" | "replay">("original");

  const run = api.data?.run;
  const flow = api.data?.flow ?? null;

  const graph = useMemo<Graph | null>(() => (flow ? flow.graph ?? flowToGraph(flow) : null), [flow]);
  const shown = view === "replay" && replay ? replay.actions : run?.actions ?? [];
  const marks = useMemo(() => marksFor(shown, graph, !flow?.graph), [shown, graph, flow]);
  const hasAi = !!run && (usesAi(run.actions) || !!flow?.graph?.nodes.some((n) => n.kind === "action" && AI_STEPS.has(n.action.type)) || !!flow?.actions.some((x) => AI_STEPS.has(x.type)));
  const useAi = aiChoice ?? hasAi;

  async function replayNow() {
    setReplaying(true);
    setReplayError("");
    try {
      setReplay(await call<Replay>(secret, "/api/personal/flows", { body: { op: "replay", run: id, useAi } }));
      setView("replay");
    } catch (e) {
      setReplayError(errMsg(e));
    } finally {
      setReplaying(false);
    }
  }

  if (api.error && !run) {
    return (
      <div className="page">
        <Back />
        <State tone="bad" title="ما قدرنا نحمّل هذا التشغيل" actions={<button type="button" className="btn brand" onClick={() => void api.reload()}>جرّب مرة ثانية</button>}>
          ممكن انحذف من السجل لأنه قديم، أو ما وصلنا للسيرفر. ({api.error})
        </State>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <Back />
        <div className="skel" style={{ height: 90 }} />
        <div className="skel" style={{ height: 320 }} />
      </div>
    );
  }

  const phone = run.chat ? "+" + run.chat.split("@")[0].split(":")[0] : "";
  const trig = run.trigger;

  return (
    <div className="page run">
      <Back />
      <div className="card run-head">
        <div>
          <h2>{run.name}</h2>
          <p className="muted">
            {new Date(run.t).toLocaleString("ar", { dateStyle: "medium", timeStyle: "medium" })}
            {run.accountLabel ? ` · ${run.accountLabel}` : ""}
            {run.chat ? ` · ${run.chatName || phone}` : run.trigger?.type === "webhook" ? " · طلب Webhook" : " · تشغيل مجدول"}
          </p>
        </div>
        <div className="run-meta">
          <span className={`status ${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
          {run.ms !== undefined && <span className="tag">المدة {fmtMs(run.ms)}</span>}
          <button type="button" className="tag" title="انسخ رقم التشغيل" onClick={() => run.id && copy(run.id, "id")}>{copied === "id" ? "تم النسخ" : `# ${run.id}`}</button>
        </div>
      </div>

      <div className="card replay-bar">
        <div className="grow">
          <strong>أعد التشغيل (تجربة)</strong>
          <p className="hint">يشغّل الفلو بنسخته الحالية على نفس الرسالة والوقت والرقم. ما يرسل ولا يحفظ مسودة ولا يعلّم ولا يضيف وسوم، حتى لو الفلو بوضع تلقائي. خطوات المساعد بالأدوات (MCP) ما تُعاد.</p>
        </div>
        {hasAi && (
          <label className="sw">
            <input type="checkbox" checked={useAi} onChange={(e) => setAiChoice(e.target.checked)} /> استدعِ الذكاء الاصطناعي فعلاً (يستهلك استدعاء)
          </label>
        )}
        <button type="button" className="btn solid" disabled={replaying || !flow} title={flow ? undefined : "الفلو انحذف"} onClick={replayNow}>
          {replaying ? "نشغّل…" : replay ? "أعد مرة ثانية" : "أعد التشغيل"}
        </button>
      </div>
      {replayError && <div className="banner bad">{replayError}</div>}

      {replay && (
        <section className="card">
          <h3>مقارنة الإعادة بالأصل</h3>
          <ul className="compare-list">
            {compare(run.actions, replay).map((c, i) => (
              <li key={i} className={c.ok ? "ok" : "err"}>{c.ok ? "✓" : "⚠"} {c.text}</li>
            ))}
          </ul>
          {replay.changed && <p className="hint">الفلو تغيّر بعد التشغيل الأصلي، فالفرق ممكن يكون من التعديل مو من الرسالة.</p>}
        </section>
      )}

      {run.resumed && <div className="note"><p>هذا تشغيل متابعة: التشغيل الأصلي وقف عند عقدة انتظار وكمّل هنا. <Link href={`/personal/flows/run/${run.resumed}`}>افتح التشغيل الأصلي</Link></p></div>}
      {run.note && <div className={`banner ${run.status === "error" ? "bad" : "ok"}`}>{run.note}</div>}
      {flow?.changed && <div className="note"><p>الفلو تغيّر بعد هذا التشغيل، فالرسم قد لا يطابق اللي اشتغل فعلاً. الخطوات تحت هي المسجلة وقت التشغيل.</p></div>}
      {!flow && <div className="note"><p>هذا الفلو انحذف، فما أقدر أرسمه. الخطوات تحت هي المسجلة وقت التشغيل.</p></div>}

      <div className="run-grid">
        {graph && flow && (
          <section className="card run-graph">
            <div className="section-head">
              <h3>مسار التشغيل</h3>
              {replay && (
                <div className="seg" role="group" aria-label="أي تشغيل تعرض">
                  <button type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>الأصلي</button>
                  <button type="button" aria-pressed={view === "replay"} onClick={() => setView("replay")}>الإعادة</button>
                </div>
              )}
            </div>
            <p className="hint">الخط الملوّن هو الطريق اللي مشت فيه الرسالة. العقد اللي ما وصلتها الرسالة باهتة.</p>
            <div className="canvas" dir="ltr">
              <Graphic graph={graph} trigger={flow.trigger} marks={marks} />
            </div>
          </section>
        )}
        <section className="card run-msg">
          <h3>{trig?.type === "webhook" ? "نص طلب الـ Webhook" : trig ? "الرسالة اللي شغّلت الفلو" : "المحفز"}</h3>
          {trig ? (
            <>
              <p className="run-who">
                {trig.senderName || (trig.sender ? "+" + trig.sender : phone)} · {trig.direction === "out" ? "منك" : "واردة"} · {trig.type}
              </p>
              <div className="answer">{trig.text ?? `[${trig.type}]`}</div>
            </>
          ) : run.text ? (
            <div className="answer">{run.text}</div>
          ) : (
            <p className="muted">{run.chat ? "سجل قديم، تفاصيله محدودة." : "الفلو المجدول ما له رسالة، يشتغل بالوقت."}</p>
          )}
        </section>
      </div>

      <section className="card">
        <h3>الخطوات {run.actions.length ? `(${run.actions.length})` : ""}</h3>
        {run.actions.length === 0 ? (
          <p className="empty">ما سُجلت خطوات لهذا التشغيل.{run.note ? "" : " ما وصلت الرسالة لأي إجراء."}</p>
        ) : (
          <ol className="timeline">
            {run.actions.map((s, i) => (
              <Step key={i} s={s} />
            ))}
          </ol>
        )}
      </section>

      {replay && (
        <section className="card">
          <h3>خطوات الإعادة {replay.actions.length ? `(${replay.actions.length})` : ""}</h3>
          {replay.actions.length === 0 ? (
            <p className="empty">ما وصلت الرسالة لأي خطوة.</p>
          ) : (
            <ol className="timeline">
              {replay.actions.map((s, i) => (
                <Step key={i} s={s} />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function Back() {
  return (
    <Link className="back" href="/personal/flows?tab=log">
      ← رجوع للسجل
    </Link>
  );
}

function Step({ s }: { s: LogEntry["actions"][number] }) {
  const [open, setOpen] = useState(!s.ok || !!s.output);
  const more = !!(s.output || s.checks?.length);
  return (
    <li className={s.ok ? "" : "bad"}>
      <span className="tl-dot" aria-hidden="true"><Icon name={s.type} /></span>
      <div className="tl-body">
        <div className="tl-row">
          <strong>{stepTitle(s.type)}</strong>
          <span className={s.ok ? "ok" : "err"}>{s.ok ? "✓ نجح" : "✗ فشل"}</span>
          {s.ms !== undefined && <span className="tag">{fmtMs(s.ms)}</span>}
          {more && <button type="button" className="btn ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "إخفاء" : "التفاصيل"}</button>}
        </div>
        {s.detail && <p className={s.ok ? "muted" : "err"}>{s.detail}</p>}
        {open && s.checks && (
          <ul className="checks-list">
            {s.checks.map((c, i) => (
              <li key={i} className={c.ok ? "ok" : "err"}>{c.ok ? "✓" : "✗"} {c.field} {c.op}{c.value ? ` "${c.value}"` : ""}{c.note ? ` (${c.note})` : ""}</li>
            ))}
          </ul>
        )}
        {open && s.output && <pre className="tl-output">{s.output}</pre>}
      </div>
    </li>
  );
}

function Graphic({ graph, trigger, marks }: { graph: Graph; trigger: Trigger; marks: Map<string, RunMark & { branch?: string }> }) {
  const nodes = useMemo(() => graph.nodes.map((n) => ({ ...toNode(n), draggable: false, data: { spec: n, run: marks.get(n.id) } })), [graph, marks]);
  // An edge was taken when its source ran, its target ran, and (after a condition) it is the branch that was chosen.
  const edges = useMemo(
    () =>
      graph.edges.map((e) => {
        const from = marks.get(e.from);
        const taken = !!marks.get(e.to) && (e.from === graph.nodes.find((n) => n.kind === "trigger")?.id || (!!from && (from.branch === undefined || from.branch === e.port)));
        const base = toEdge(e);
        return { ...base, className: `${base.className ?? ""} ${taken ? "edge-ran" : "edge-idle"}`.trim() };
      }),
    [graph, marks],
  );
  return (
    <Ctx.Provider value={{ trigger, edges, onAdd: () => {}, readOnly: true }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.6, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Ctx.Provider>
  );
}
