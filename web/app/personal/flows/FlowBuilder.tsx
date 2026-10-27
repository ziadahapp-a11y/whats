"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { flowToGraph, freshId, unreachable, X_STEP, Y_STEP } from "@/lib/flows/graph";
import { exportFlows } from "@/lib/flows/portable";
import { Graph, type Action, type Cond, type GraphEdge, type GraphNode, type Trigger } from "@/lib/flows/types";
import { call, errMsg, useCopy } from "../shared";
import { ActionFields } from "./ActionFields";
import { downloadJson, fileSafe } from "./download";
import { ACTION_LABEL, FIELD_LABEL, NO_VALUE, OP_LABEL, newAction, type ActionType, type EF } from "./presets";

type Port = GraphEdge["port"];
type Spec = GraphNode;
export type RunMark = { ok: boolean; detail?: string };
export type FNode = Node<{ spec: Spec; run?: RunMark }, Spec["kind"]>;

export type BuilderData = {
  ai: { configured: boolean; cheap?: boolean; cheapModel?: string; defaultPrompt: string };
  accounts: { id: string; label: string }[];
  fields: string[];
  ops: string[];
};
export type TestResult = { triggered: boolean; matched: boolean; conditions: { field: string; op: string; value?: string; ok: boolean; note?: string }[]; actions: { type: string; ok: boolean; detail?: string; node?: string }[] };

const MODE_NOTE: Record<EF["mode"], string> = {
  approve: "الأكثر أماناً: الفلو يجهز الرد ويحطه في المسودات، وما يوصل أحد شي إلا لما توافق عليه من صندوق الوارد.",
  auto: "يرسل فوراً من رقمك بدون ما يسألك. شغّله بعد ما تجرب الفلو وتتأكد من الشروط. فيه حد أقصى لكل ساعة ولكل محادثة كحماية.",
  dry: "تجربة: يقيّم الشروط ويكتب في السجل إيش كان بيسوي، بدون ما يرسل أو يعلّم أي شي.",
};

export const TITLE: Record<ActionType, string> = {
  reply: "ردّ", ai_reply: "رد بالذكاء الاصطناعي", send: "إرسال لرقم", ai: "توليد نص بالذكاء الاصطناعي", agent: "مساعد بالأدوات",
  react: "تفاعل", mark_read: "تعليم كمقروءة", tag: "وسم", webhook: "Webhook", delay: "انتظار", stop: "إيقاف الباقي",
};
export const ICON: Record<string, string> = { trigger: "⚡", condition: "🔀", reply: "💬", ai_reply: "🤖", send: "📤", ai: "✨", agent: "🛠", react: "😀", mark_read: "✓", tag: "🏷", webhook: "🔗", delay: "⏱", stop: "⛔" };
const GROUPS: { title: string; types: ActionType[] }[] = [
  { title: "رسائل", types: ["reply", "send", "react", "mark_read"] },
  { title: "ذكاء اصطناعي", types: ["ai_reply", "ai", "agent"] },
  { title: "الوقت", types: ["delay"] },
  { title: "أخرى", types: ["tag", "webhook", "stop"] },
];

const DIR = { in: "رسائل تجيني", out: "رسائل أرسلها أنا", any: "كل الرسائل" } as const;
const CHATS = { direct: "الخاصة", group: "المجموعات", both: "كل المحادثات" } as const;
const clip = (s: string, n = 46) => (s.length > n ? s.slice(0, n) + "…" : s);

function triggerSummary(t: Trigger) {
  if (t.type === "message") return `${DIR[t.direction]} · ${CHATS[t.chats]}`;
  if (t.type === "webhook") return "لما يوصل طلب Webhook موقّع";
  return t.atHour !== undefined ? `يومياً بعد الساعة ${t.atHour}:00` : `كل ${t.everyMinutes} دقيقة`;
}
function condSummary(conds: Cond[]) {
  const c = conds[0];
  if (!c) return "";
  const v = c.value === undefined || c.value === "" || NO_VALUE.has(c.op) ? "" : ` "${clip(String(c.value), 22)}"`;
  const one = `${(FIELD_LABEL[c.field] ?? c.field).split(" (")[0]} ${OP_LABEL[c.op] ?? c.op}${v}`;
  return conds.length > 1 ? `${one} +${conds.length - 1}` : one;
}
function actionSummary(a: Action) {
  switch (a.type) {
    case "reply": return clip(a.text);
    case "send": return clip(`${a.to}: ${a.text}`);
    case "react": return a.emoji;
    case "tag": return a.tag;
    case "webhook": return clip(a.url);
    case "delay": return `${a.minutes % 1440 === 0 ? `${a.minutes / 1440} يوم` : a.minutes % 60 === 0 ? `${a.minutes / 60} ساعة` : `${a.minutes} دقيقة`}${a.cancelOnReply ? " (يلغى لو ردّ)" : ""}`;
    case "ai_reply": case "ai": case "agent": return a.prompt ? clip(a.prompt) : "التعليمات الافتراضية";
    default: return "";
  }
}

const specTitle = (s: Spec) => (s.kind === "trigger" ? "المحفز" : s.kind === "condition" ? "شرط" : TITLE[s.action.type]);

// ---------- canvas nodes ----------

/** `readOnly` hides the "+" buttons: the run details page draws the same nodes without editing. */
export const Ctx = createContext<{ trigger: Trigger; edges: Edge[]; onAdd: (id: string, port: Port) => void; readOnly?: boolean }>({ trigger: { type: "message", direction: "in", chats: "direct" }, edges: [], onAdd: () => {} });

function Plus({ id, port, top }: { id: string; port: Port; top: string }) {
  const { edges, onAdd, readOnly } = useContext(Ctx);
  if (readOnly || edges.some((e) => e.source === id && (e.sourceHandle ?? "next") === port)) return null;
  return (
    <button type="button" className="fn-plus nodrag nopan" style={{ top }} aria-label="أضف الخطوة التالية" title="أضف الخطوة التالية" onClick={(e) => (e.stopPropagation(), onAdd(id, port))}>
      +
    </button>
  );
}

function Card({ kind, icon, title, sub, run, selected, children }: { kind: string; icon: string; title: string; sub?: string; run?: RunMark; selected?: boolean; children?: React.ReactNode }) {
  const { readOnly } = useContext(Ctx);
  return (
    <div className={`fnode ${kind}${selected ? " sel" : ""}${run ? (run.ok ? " ran" : " failed") : readOnly ? " idle" : ""}`} dir="rtl">
      <span className="fn-icon" aria-hidden="true">{icon}</span>
      <div className="fn-text">
        <strong>{title}</strong>
        {sub && <span>{sub}</span>}
      </div>
      {run && <span className="fn-run" title={run.detail}>{run.ok ? "✓" : "✗"}</span>}
      {children}
    </div>
  );
}

function TriggerNode({ id, data, selected }: NodeProps<FNode>) {
  const { trigger } = useContext(Ctx);
  return (
    <Card kind="trigger" icon={ICON.trigger} title="المحفز" sub={triggerSummary(trigger)} run={data.run} selected={selected}>
      <Handle type="source" position={Position.Right} id="next" />
      <Plus id={id} port="next" top="50%" />
    </Card>
  );
}

function ConditionNode({ id, data, selected }: NodeProps<FNode>) {
  const spec = data.spec as Extract<Spec, { kind: "condition" }>;
  return (
    <Card kind="condition" icon={ICON.condition} title="شرط" sub={condSummary(spec.conditions)} run={data.run} selected={selected}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} id="true" style={{ top: "32%" }} />
      <Handle type="source" position={Position.Right} id="false" style={{ top: "70%" }} />
      <span className="fn-port yes" style={{ top: "32%" }}>نعم</span>
      <span className="fn-port no" style={{ top: "70%" }}>لا</span>
      <Plus id={id} port="true" top="32%" />
      <Plus id={id} port="false" top="70%" />
    </Card>
  );
}

function ActionNode({ id, data, selected }: NodeProps<FNode>) {
  const spec = data.spec as Extract<Spec, { kind: "action" }>;
  return (
    <Card kind={`action ${spec.action.type.startsWith("ai") || spec.action.type === "agent" ? "ai" : ""}`} icon={ICON[spec.action.type]} title={TITLE[spec.action.type]} sub={actionSummary(spec.action)} run={data.run} selected={selected}>
      <Handle type="target" position={Position.Left} />
      {spec.action.type !== "stop" && <Handle type="source" position={Position.Right} id="next" />}
      {spec.action.type !== "stop" && <Plus id={id} port="next" top="50%" />}
    </Card>
  );
}

export const nodeTypes = { trigger: TriggerNode, condition: ConditionNode, action: ActionNode };

// ---------- conversions ----------

export const toNode = (n: GraphNode): FNode => ({ id: n.id, type: n.kind, position: { x: n.x, y: n.y }, data: { spec: n }, deletable: n.kind !== "trigger" });
const edgeId = (e: GraphEdge) => `${e.from}-${e.port}-${e.to}`;
export const toEdge = (e: GraphEdge): Edge => ({
  id: edgeId(e), source: e.from, sourceHandle: e.port, target: e.to,
  markerEnd: { type: MarkerType.ArrowClosed },
  label: e.port === "true" ? "نعم" : e.port === "false" ? "لا" : undefined,
  className: e.port === "next" ? undefined : `edge-${e.port}`,
});

function serialize(nodes: FNode[], edges: Edge[]) {
  return {
    nodes: nodes.map((n) => ({ ...n.data.spec, id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
    edges: edges.map((e) => ({ from: e.source, port: (e.sourceHandle ?? "next") as Port, to: e.target })),
  };
}

// ---------- builder ----------

type Props = { secret: string; data: BuilderData; value: EF; saving: boolean; error: string; onSave: (f: EF) => void; onDelete: (f: EF) => void; onCancel: () => void };

export function FlowBuilder(props: Props) {
  const { secret, data, value, saving, error, onSave, onDelete, onCancel } = props;
  const initial = useMemo(() => value.graph ?? flowToGraph(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>(initial.nodes.map(toNode));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges.map(toEdge));
  const [f, setF] = useState<EF>(value);
  const [adding, setAdding] = useState<{ from?: string; port?: Port } | null>(null);
  const [localError, setLocalError] = useState("");
  const flowRef = useRef<ReactFlowInstance<FNode, Edge> | null>(null);
  const set = <K extends keyof EF>(k: K, v: EF[K]) => setF((x) => ({ ...x, [k]: v }));
  const selected = adding ? undefined : nodes.find((n) => n.selected);

  const patch = (id: string, fn: (s: Spec) => Spec) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, spec: fn(n.data.spec), run: undefined } } : n)));

  const place = (from: string | undefined, port: Port | undefined) => {
    const parent = from ? nodes.find((n) => n.id === from) : undefined;
    const used = edges.filter((e) => e.source === from).length;
    let x = parent ? parent.position.x + X_STEP : Math.max(0, ...nodes.map((n) => n.position.x)) + X_STEP;
    let y = parent ? parent.position.y + (port === "true" ? -Y_STEP / 2 : port === "false" ? Y_STEP / 2 : 0) + (port === "next" ? used * Y_STEP : 0) : 0;
    while (nodes.some((n) => Math.abs(n.position.x - x) < 60 && Math.abs(n.position.y - y) < 60)) y += Y_STEP;
    return { x, y };
  };

  const addNode = (what: "condition" | ActionType) => {
    const g = serialize(nodes, edges) as Graph;
    const id = freshId(g, what === "condition" ? "c" : "a");
    const { x, y } = place(adding?.from, adding?.port);
    const spec: GraphNode =
      what === "condition"
        ? { id, kind: "condition", x, y, match: "all", conditions: [{ field: "text", op: "contains_any", value: "" }] }
        : { id, kind: "action", x, y, action: newAction(what) };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(spec), selected: true }]);
    if (adding?.from) setEdges((es) => [...es, toEdge({ from: adding.from!, port: adding.port ?? "next", to: id })]);
    setAdding(null);
    // bring the new node into view: a long chain would otherwise add it off screen
    setTimeout(() => flowRef.current?.setCenter(x + 118, y + 34, { zoom: Math.max(flowRef.current.getZoom(), 0.75), duration: 300 }), 60);
  };

  const onConnect = useCallback(
    (c: Connection) => {
      const e: GraphEdge = { from: c.source, port: (c.sourceHandle ?? "next") as Port, to: c.target };
      setEdges((es) => (es.some((x) => x.id === edgeId(e)) ? es : [...es, toEdge(e)]));
    },
    [setEdges],
  );
  const isValid = useCallback(
    (c: Connection | Edge) => c.source !== c.target && nodes.find((n) => n.id === c.target)?.type !== "trigger" && !edges.some((e) => e.id === edgeId({ from: c.source, port: (c.sourceHandle ?? "next") as Port, to: c.target })),
    [nodes, edges],
  );

  const removeNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  const build = (): EF => ({ ...f, conditions: [], actions: [], graph: serialize(nodes, edges) as Graph });
  const orphans = useMemo(() => {
    const g = Graph.safeParse(serialize(nodes, edges));
    return g.success ? unreachable(g.data) : [];
  }, [nodes, edges]);

  const save = () => {
    const g = Graph.safeParse(serialize(nodes, edges));
    if (!g.success) {
      // point at the node with the problem instead of a raw schema message
      const issue = g.error.issues[0];
      const bad = issue.path[0] === "nodes" ? nodes[Number(issue.path[1])] : undefined;
      if (bad) {
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === bad.id })));
        setAdding(null);
        const what = issue.code === "too_small" ? "حقل مطلوب فاضي" : issue.code === "invalid_format" ? "قيمة غير صالحة (مثل رابط ناقص)" : issue.message;
        return setLocalError(`عقدة "${specTitle(bad.data.spec)}": ${what}`);
      }
      return setLocalError(issue.message.startsWith("a flow needs") ? (issue.message.includes("trigger") ? "الفلو يحتاج محفز واحد بالضبط" : "الفلو يحتاج إجراء واحد على الأقل") : issue.message);
    }
    setLocalError("");
    onSave(build());
  };

  return (
    <div className="builder">
      <header className="builder-bar">
        <input aria-label="اسم الفلو" className="builder-name" value={f.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
        <label className="sw"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> {f.enabled ? "مفعّل" : "متوقف"}</label>
        <span className="grow" />
        {orphans.length > 0 && <span className="chip off" title="عقد ما توصل لها من المحفز، فما راح تشتغل">⚠ {orphans.length} عقدة غير موصولة</span>}
        <button type="button" className="btn ghost small" onClick={() => setAdding({})}>+ عقدة</button>
        <button type="button" className="btn ghost small" title="ينزّل الفلو كملف JSON (بدون قيم الترويسات)" onClick={() => downloadJson(fileSafe(f.name), exportFlows([build()]))}>تصدير</button>
        <button type="button" className="btn solid" onClick={save} disabled={saving}>{saving ? "نحفظ…" : "احفظ الفلو"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>إغلاق</button>
        {f.id && <button type="button" className="btn ghost danger" onClick={() => onDelete(value)}>احذف</button>}
      </header>
      {(error || localError) && <p className="err builder-err">{error || localError}</p>}

      <div className="builder-body">
        <div className="canvas" dir="ltr">
          <Ctx.Provider value={{ trigger: f.trigger, edges, onAdd: (from, port) => setAdding({ from, port }) }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValid}
              onNodeClick={() => setAdding(null)}
              onPaneClick={() => setAdding(null)}
              onInit={(i) => (flowRef.current = i)}
              fitView
              fitViewOptions={{ padding: 0.12, minZoom: 0.6, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.6}
              colorMode="system"
              defaultEdgeOptions={{ type: "default" }}
              deleteKeyCode={["Backspace", "Delete"]}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="builder-mini" />
            </ReactFlow>
          </Ctx.Provider>
        </div>

        <aside className="builder-panel" aria-label="إعدادات">
          {adding ? (
            <Palette from={adding.from ? nodes.find((n) => n.id === adding.from) : undefined} port={adding.port} onPick={addNode} onClose={() => setAdding(null)} />
          ) : selected ? (
            <NodeEditor node={selected} f={f} secret={secret} setTrigger={(t) => set("trigger", t)} data={data} patch={patch} onRemove={() => removeNode(selected.id)} />
          ) : (
            <Settings f={f} set={set} data={data} secret={secret} build={build} setRun={(m) => setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, run: m.get(n.id) } })))} />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------- side panel ----------

function Palette({ from, port, onPick, onClose }: { from?: FNode; port?: Port; onPick: (w: "condition" | ActionType) => void; onClose: () => void }) {
  return (
    <div className="panel-stack">
      <div className="panel-head">
        <h4>{from ? "الخطوة التالية" : "إضافة عقدة"}</h4>
        <button type="button" className="btn ghost small" onClick={onClose}>إلغاء</button>
      </div>
      {from && <p className="hint">بعد {from.type === "trigger" ? "المحفز" : from.type === "condition" ? `الشرط (${port === "true" ? "لما يتحقق" : "لما ما يتحقق"})` : "الإجراء"}. تقدر بعدين تسحب الأسلاك بين العقد.</p>}
      <div className="palette">
        <h5>منطق</h5>
        <button type="button" onClick={() => onPick("condition")}><span>{ICON.condition}</span><div><strong>شرط</strong><small>يتفرع إلى نعم / لا</small></div></button>
        {GROUPS.map((g) => (
          <div key={g.title} className="palette-group">
            <h5>{g.title}</h5>
            {g.types.map((t) => (
              <button type="button" key={t} onClick={() => onPick(t)}><span>{ICON[t]}</span><div><strong>{TITLE[t]}</strong><small>{ACTION_LABEL[t]}</small></div></button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeEditor({ node, f, secret, setTrigger, data, patch, onRemove }: { node: FNode; f: EF; secret: string; setTrigger: (t: Trigger) => void; data: BuilderData; patch: (id: string, fn: (s: Spec) => Spec) => void; onRemove: () => void }) {
  const spec = node.data.spec;
  const title = spec.kind === "trigger" ? "المحفز" : spec.kind === "condition" ? "شرط" : TITLE[spec.action.type];
  return (
    <div className="panel-stack">
      <div className="panel-head">
        <h4><span aria-hidden="true">{ICON[spec.kind === "action" ? spec.action.type : spec.kind]}</span> {title}</h4>
        {spec.kind !== "trigger" && <button type="button" className="btn ghost small danger" onClick={onRemove}>احذف العقدة</button>}
      </div>
      {node.data.run && <p className={node.data.run.ok ? "mode-note" : "err"}>{node.data.run.ok ? "✓" : "✗"} {node.data.run.detail}</p>}
      {spec.kind === "trigger" && <TriggerFields t={f.trigger} onChange={setTrigger} />}
      {spec.kind === "trigger" && f.trigger.type === "webhook" && <HookInfo secret={secret} flowId={f.id} />}
      {spec.kind === "condition" && <ConditionFields spec={spec} data={data} onChange={(s) => patch(node.id, () => s)} />}
      {spec.kind === "action" && (
        <>
          <ActionFields a={spec.action} onChange={(action) => patch(node.id, () => ({ ...spec, action }))} defaultPrompt={data.ai.defaultPrompt} aiOn={data.ai.configured} cheapModel={data.ai.cheap ? data.ai.cheapModel ?? "cheap" : undefined} />
          <p className="hint">المتغيرات داخل النصوص: {"{{text}} {{sender_name}} {{sender}} {{chat_name}} {{time}} {{date}} {{me}} {{ai}}"}</p>
        </>
      )}
    </div>
  );
}

function TriggerFields({ t, onChange }: { t: Trigger; onChange: (t: Trigger) => void }) {
  const pick = (v: string): Trigger => (v === "message" ? { type: "message", direction: "in", chats: "direct" } : v === "webhook" ? { type: "webhook" } : { type: "schedule", everyMinutes: 1440, atHour: 8 });
  return (
    <div className="grid2">
      <label>النوع
        <select value={t.type} onChange={(e) => onChange(pick(e.target.value))}>
          <option value="message">لما توصل رسالة</option>
          <option value="schedule">على جدول زمني</option>
          <option value="webhook">لما يوصل طلب Webhook من نظام خارجي</option>
        </select>
      </label>
      {t.type === "message" && (
        <>
          <label>الاتجاه
            <select value={t.direction} onChange={(e) => onChange({ ...t, direction: e.target.value as typeof t.direction })}>
              <option value="in">رسائل تجيني</option><option value="out">رسائل أرسلها أنا</option><option value="any">الاثنين</option>
            </select>
          </label>
          <label>المحادثات
            <select value={t.chats} onChange={(e) => onChange({ ...t, chats: e.target.value as typeof t.chats })}>
              <option value="direct">الخاصة فقط</option><option value="group">المجموعات فقط</option><option value="both">الكل</option>
            </select>
          </label>
        </>
      )}
      {t.type === "schedule" && (
        <>
          <label>كل كم دقيقة<input type="number" min={5} value={t.everyMinutes} onChange={(e) => onChange({ ...t, everyMinutes: Number(e.target.value) })} /></label>
          <label>أو يومياً بعد الساعة (اختياري)
            <input type="number" min={0} max={23} value={t.atHour ?? ""} placeholder="مثلاً 8" onChange={(e) => onChange({ ...t, atHour: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </label>
          <p className="hint">الفلو المجدول ما له محادثة، فاستخدم "إرسال لرقم" والذكاء الاصطناعي وWebhook فقط. الجدول يتحقق وقت المزامنة.</p>
        </>
      )}
    </div>
  );
}

/** Address, secret and a signed example request for a webhook-triggered flow. */
function HookInfo({ secret, flowId }: { secret: string; flowId?: string }) {
  const [info, setInfo] = useState<{ url: string; secret: string } | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copied, copy } = useCopy();
  if (!flowId) return <p className="mode-note">احفظ الفلو أول، وبعدها يطلع لك رابط الـ Webhook وسرّه هنا.</p>;
  const load = async (op: "hook" | "rotate_hook") => {
    if (op === "rotate_hook" && !confirm("تغيير السر يوقف أي نظام يستخدم السر الحالي لين تحدّثه. أكمل؟")) return;
    setBusy(true);
    setError("");
    try {
      setInfo(await call<{ url: string; secret: string }>(secret, "/api/personal/flows", { body: { op, id: flowId } }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const sample = info
    ? `URL='${info.url}'
SECRET='${info.secret}'
BODY='{"to":"9665XXXXXXXX","text":"طلب جديد","data":{"order":"1234"}}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -X POST "$URL" -H 'Content-Type: application/json' -H "X-Timestamp: $TS" -H "X-Signature: $SIG" -d "$BODY"`
    : "";
  return (
    <div className="hook-info">
      {!info ? (
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void load("hook")}>{busy ? "…" : "اعرض الرابط والسر"}</button>
      ) : (
        <>
          <label>الرابط</label>
          <div className="code"><pre dir="ltr">{info.url}</pre><button type="button" className="copy" onClick={() => copy(info.url, "u")}>{copied === "u" ? "تم" : "انسخ"}</button></div>
          <label>السر</label>
          <div className="code"><pre dir="ltr">{show ? info.secret : "whsec_" + "•".repeat(20)}</pre><button type="button" className="copy" onClick={() => copy(info.secret, "s")}>{copied === "s" ? "تم" : "انسخ"}</button></div>
          <div className="row">
            <button type="button" className="btn ghost small" onClick={() => setShow(!show)}>{show ? "إخفاء السر" : "إظهار السر"}</button>
            <button type="button" className="btn ghost small danger" disabled={busy} onClick={() => void load("rotate_hook")}>تغيير السر</button>
          </div>
          <details>
            <summary>مثال طلب موقّع (curl)</summary>
            <div className="code"><pre dir="ltr">{sample}</pre><button type="button" className="copy" onClick={() => copy(sample, "c")}>{copied === "c" ? "تم" : "انسخ"}</button></div>
          </details>
        </>
      )}
      {error && <p className="err">{error}</p>}
      <p className="hint">
        كل طلب لازم يحمل X-Timestamp (ثواني unix) وX-Signature بقيمة sha256=HMAC-SHA256 للنص "الوقت.الجسم" بالسر. الطلب الأقدم من 5 دقائق أو المكرر ينرفض، والحد 60 طلب بالدقيقة.
        الجسم: to (رقم المحادثة)، text يصير {"{{text}}"}، وحقول data تصير {"{{hook_الاسم}}"}. الفلو يرسل بس لمحادثات موجودة عندك، ولازم يكون مفعّل ومحفوظ بهذا المحفز.
      </p>
    </div>
  );
}

function ConditionFields({ spec, data, onChange }: { spec: Extract<Spec, { kind: "condition" }>; data: BuilderData; onChange: (s: Extract<Spec, { kind: "condition" }>) => void }) {
  const setCond = (i: number, c: Cond) => onChange({ ...spec, conditions: spec.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <>
      <div className="grid2">
        <label>لازم يتحقق
          <select value={spec.match} onChange={(e) => onChange({ ...spec, match: e.target.value as "all" | "any" })}>
            <option value="all">كل الشروط</option><option value="any">أي شرط</option>
          </select>
        </label>
      </div>
      {spec.conditions.map((c, i) => (
        <div className="cond" key={i}>
          <select aria-label="الحقل" value={c.field} onChange={(e) => setCond(i, e.target.value === "ai" ? { field: "ai", op: "yes", value: "" } : { ...c, field: e.target.value as Cond["field"], op: c.field === "ai" ? "contains" : c.op })}>
            {data.fields.map((x) => <option key={x} value={x}>{FIELD_LABEL[x] ?? x}</option>)}
          </select>
          <select aria-label="العملية" value={c.op} disabled={c.field === "ai"} onChange={(e) => setCond(i, { ...c, op: e.target.value as Cond["op"] })}>
            {data.ops.filter((o) => (c.field === "ai" ? o === "yes" : o !== "yes")).map((o) => <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>)}
          </select>
          {NO_VALUE.has(c.op) ? <span /> : (
            <input aria-label="القيمة" value={String(c.value ?? "")} placeholder={c.field === "ai" ? "السؤال: هل الرسالة طلب سعر؟" : c.op === "contains_any" || c.op === "in" ? "كلمات مفصولة بفاصلة" : "القيمة"} onChange={(e) => setCond(i, { ...c, value: e.target.value })} />
          )}
          <button type="button" className="btn ghost small" aria-label="احذف الشرط" disabled={spec.conditions.length === 1} onClick={() => onChange({ ...spec, conditions: spec.conditions.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      {spec.conditions.length < 10 && <button type="button" className="btn ghost small" onClick={() => onChange({ ...spec, conditions: [...spec.conditions, { field: "text", op: "contains_any", value: "" }] })}>+ شرط</button>}
      <p className="hint">الكلمات العربية تُقارن بدون تشكيل. وصّل مخرج "نعم" بالخطوة اللي تشتغل لما يتحقق الشرط، ومخرج "لا" بغيرها أو اتركه فاضي.</p>
    </>
  );
}

function Settings({ f, set, data, secret, build, setRun }: { f: EF; set: <K extends keyof EF>(k: K, v: EF[K]) => void; data: BuilderData; secret: string; build: () => EF; setRun: (m: Map<string, RunMark>) => void }) {
  const [sample, setSample] = useState({ text: "السلام عليكم، كم سعر الباقة؟", senderName: "سارة" });
  const [useAi, setUseAi] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testing, setTesting] = useState(false);
  const isMsg = f.trigger.type === "message";

  async function test() {
    setTesting(true);
    setTestError("");
    setResult(null);
    try {
      const r = await call<TestResult>(secret, "/api/personal/flows", { body: { op: "test", flow: build(), sample, useAi } });
      setResult(r);
      const marks = new Map<string, RunMark>();
      for (const a of r.actions) if (a.node) marks.set(a.node, { ok: a.ok, detail: a.detail });
      setRun(marks);
    } catch (e) {
      setTestError(errMsg(e));
      setRun(new Map());
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="panel-stack">
      <div className="panel-head"><h4>إعدادات الفلو</h4></div>
      <p className="hint">اضغط على أي عقدة لتعديلها، أو على + بجانب مخرجها لإضافة الخطوة التالية. اسحب من نقطة المخرج إلى عقدة ثانية للتوصيل، ومن الزر Delete تحذف العقدة أو السلك المحدد.</p>
      <div className="grid2">
        <label>الرقم
          <select value={f.account} onChange={(e) => set("account", e.target.value)}>
            <option value="*">كل الأرقام</option>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label>الوضع
          <select value={f.mode} onChange={(e) => set("mode", e.target.value as EF["mode"])}>
            <option value="approve">مسودة (تنتظر موافقتي)</option>
            <option value="auto">تلقائي (يرسل فوراً)</option>
            <option value="dry">تجربة (سجل فقط)</option>
          </select>
        </label>
      </div>
      <p className="mode-note">{MODE_NOTE[f.mode]}</p>

      <details>
        <summary><strong>حدود الأمان</strong></summary>
        <div className="grid2" style={{ marginTop: 10 }}>
          <label>أقصى عمر للرسالة (دقيقة)<input type="number" min={1} value={f.maxAgeMinutes} onChange={(e) => set("maxAgeMinutes", Number(e.target.value))} /></label>
          <label>انتظار بين ردين لنفس الشخص (ثانية)<input type="number" min={0} value={f.cooldownSeconds} onChange={(e) => set("cooldownSeconds", Number(e.target.value))} /></label>
          <label>أقصى عدد في الساعة<input type="number" min={1} value={f.maxPerHour} onChange={(e) => set("maxPerHour", Number(e.target.value))} /></label>
          <label>المنطقة الزمنية<input dir="ltr" value={f.tz} onChange={(e) => set("tz", e.target.value)} /></label>
          <label className="sw"><input type="checkbox" checked={f.stopOnMatch} onChange={(e) => set("stopOnMatch", e.target.checked)} /> إذا اشتغل أوقف الفلوات اللي بعده</label>
        </div>
        <p className="hint">الفلو يتجاهل الرسائل الأقدم من وقت تفعيله، وفيه حد ثابت على الرسائل التلقائية لكل محادثة في الساعة عشان ما يدخل في حلقة مع بوت ثاني.</p>
      </details>

      {isMsg && (
        <section>
          <h4>جرّب قبل ما تفعّل</h4>
          <div className="grid2">
            <label>نص رسالة تجريبية<input value={sample.text} onChange={(e) => setSample({ ...sample, text: e.target.value })} /></label>
            <label>اسم المرسل<input value={sample.senderName} onChange={(e) => setSample({ ...sample, senderName: e.target.value })} /></label>
            <label className="sw"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} disabled={!data.ai.configured} /> استدعِ الذكاء الاصطناعي فعلاً (يحسب من استهلاكك)</label>
          </div>
          <button type="button" className="btn ghost" onClick={test} disabled={testing}>{testing ? "نجرب…" : "جرّب"}</button>
          {testError && <p className="err">{testError}</p>}
          {result && (
            <div className="result" style={{ marginTop: 12 }}>
              <p><strong className={result.matched ? "ok" : "err"}>{result.matched ? "الفلو بيشتغل على هذي الرسالة (شوف العقد اللي علّمناها على اللوحة)" : result.triggered ? "الرسالة ما وصلت لأي إجراء" : "المحفز ما ينطبق (اتجاه أو نوع محادثة)"}</strong></p>
              <ul>
                {result.actions.map((a, i) => <li key={i} className={a.ok ? "" : "err"}>{a.type === "condition" ? "شرط" : TITLE[a.type as ActionType] ?? a.type}: {a.detail}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
