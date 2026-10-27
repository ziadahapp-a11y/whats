// What a flow is: a trigger, optional conditions, and a list of actions, or (new) a graph of
// nodes where condition nodes branch into "true" and "false". Old linear flows keep working.
// Everything here is validated with zod, because flows come from the dashboard.

import { z } from "zod";

export const OPS = [
  "contains", "not_contains", "contains_any", "contains_all", "equals", "not_equals", "starts_with", "ends_with",
  "regex", "not_regex", "in", "not_in", "gt", "gte", "lt", "lte", "is_true", "is_false", "is_empty", "not_empty", "yes",
] as const;

export const FIELDS = [
  "text", "sender", "sender_name", "chat", "chat_name", "chat_type", "type", "has_media", "direction",
  "from_owner", "self_chat", "hour", "weekday", "is_first", "is_reply", "length", "tag", "ai",
] as const;

export const Cond = z.object({
  field: z.enum(FIELDS),
  op: z.enum(OPS),
  value: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
});
export type Cond = z.infer<typeof Cond>;

const text = z.string().min(1).max(4096);
const aiFields = {
  prompt: z.string().max(4000).default(""),
  model: z.string().max(80).optional(),
  /** claude (default) or the cheap OpenAI-compatible provider set in the environment */
  provider: z.enum(["claude", "cheap"]).optional(),
  context: z.number().int().min(1).max(60).default(12),
  maxTokens: z.number().int().min(64).max(2000).default(500),
  /** chat = the conversation that triggered the flow; recent = every chat with news in the last `hours`. */
  scope: z.enum(["chat", "recent"]).default("chat"),
  hours: z.number().int().min(1).max(168).default(24),
  /** answer from the knowledge base (default: yes for ai_reply, no for ai) */
  knowledge: z.boolean().optional(),
};

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reply"), text, quote: z.boolean().default(false) }),
  z.object({ type: z.literal("send"), to: z.string().min(1).max(200), text }),
  z.object({ type: z.literal("react"), emoji: z.string().min(1).max(8) }),
  z.object({ type: z.literal("mark_read") }),
  z.object({ type: z.literal("tag"), tag: z.string().min(1).max(40) }),
  z.object({ type: z.literal("ai_reply"), quote: z.boolean().default(false), ...aiFields }),
  z.object({ type: z.literal("ai"), ...aiFields }),
  z.object({
    type: z.literal("agent"),
    /** extra instructions; for a scheduled flow this IS the task */
    prompt: z.string().max(4000).default(""),
    /** owner-message flows: show the plan and wait for "yes" before using tools */
    confirm: z.boolean().default(true),
    /** connector names to allow; empty = all */
    connectors: z.array(z.string().max(30)).max(10).default([]),
    model: z.string().max(80).optional(),
    provider: z.enum(["claude", "cheap"]).optional(),
    maxTokens: z.number().int().min(256).max(8000).default(2000),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url().max(500),
    method: z.enum(["POST", "GET"]).default("POST"),
    headers: z.record(z.string().max(80), z.string().max(500)).default({}),
  }),
  z.object({
    type: z.literal("delay"),
    /** graph flows only: the steps after this one run once this long has passed (checked at each sync) */
    minutes: z.number().int().min(1).max(20160),
    /** skip the rest if the other person wrote again while we waited */
    cancelOnReply: z.boolean().default(false),
  }),
  z.object({ type: z.literal("stop") }),
]);
export type Action = z.infer<typeof Action>;

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const Trigger = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    direction: z.enum(["in", "out", "any"]).default("in"),
    chats: z.enum(["direct", "group", "both"]).default("direct"),
  }),
  z.object({
    type: z.literal("schedule"),
    everyMinutes: z.number().int().min(5).max(10080).default(1440),
    atHour: z.number().int().min(0).max(23).optional(),
  }),
  /** an outside system calls /api/hooks/<flow id> with a signed request; the secret lives outside the flow */
  z.object({ type: z.literal("webhook") }),
]);
export type Trigger = z.infer<typeof Trigger>;


// ---------- graph (node editor) ----------

const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
const pos = { x: z.number().min(-20000).max(20000).default(0), y: z.number().min(-20000).max(20000).default(0) };

export const GraphNode = z.discriminatedUnion("kind", [
  /** the trigger's settings live in `flow.trigger`; this node is its place on the canvas */
  z.object({ id: NodeId, kind: z.literal("trigger"), ...pos }),
  z.object({ id: NodeId, kind: z.literal("condition"), ...pos, match: z.enum(["all", "any"]).default("all"), conditions: z.array(Cond).min(1).max(10) }),
  z.object({ id: NodeId, kind: z.literal("action"), ...pos, action: Action }),
]);
export type GraphNode = z.infer<typeof GraphNode>;

export const PORTS = ["next", "true", "false"] as const;
export const GraphEdge = z.object({ from: NodeId, port: z.enum(PORTS).default("next"), to: NodeId });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z
  .object({ nodes: z.array(GraphNode).min(2).max(40), edges: z.array(GraphEdge).max(80) })
  .superRefine((g, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    const kind = new Map<string, GraphNode["kind"]>();
    for (const n of g.nodes) {
      if (kind.has(n.id)) bad(`duplicate node id "${n.id}"`);
      kind.set(n.id, n.kind);
    }
    if (g.nodes.filter((n) => n.kind === "trigger").length !== 1) bad("a flow needs exactly one trigger node");
    if (!g.nodes.some((n) => n.kind === "action")) bad("a flow needs at least one action node");
    const seen = new Set<string>();
    for (const e of g.edges) {
      const from = kind.get(e.from);
      if (!from || !kind.has(e.to)) bad("a wire points at a node that does not exist");
      else if (kind.get(e.to) === "trigger") bad("nothing can lead into the trigger");
      else if (e.from === e.to) bad("a node cannot be wired to itself");
      else if ((from === "condition") !== (e.port !== "next")) bad(from === "condition" ? "condition nodes wire from the true or false output" : "only condition nodes have true and false outputs");
      const key = `${e.from}:${e.port}:${e.to}`;
      if (seen.has(key)) bad("the same wire appears twice");
      seen.add(key);
    }
    // A loop would run its steps again and again (with a delay in it, forever, one lap per sync).
    const next = new Map<string, string[]>();
    for (const e of g.edges) if (kind.has(e.from) && kind.has(e.to)) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    const mark = new Map<string, 1 | 2>();
    const loops = (id: string): boolean => {
      if (mark.get(id) === 2) return false;
      if (mark.get(id) === 1) return true;
      mark.set(id, 1);
      const hit = (next.get(id) ?? []).some(loops);
      mark.set(id, 2);
      return hit;
    };
    if (g.nodes.some((n) => loops(n.id))) bad("the flow loops back on itself");
  });
export type Graph = z.infer<typeof Graph>;

export const FlowInput = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{4,40}$/).optional(),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    /** "*" = every number, otherwise one account id (or "official"). */
    account: z.string().min(1).max(30).default("*"),
    trigger: Trigger.default({ type: "message", direction: "in", chats: "direct" }),
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(Cond).max(20).default([]),
    /** linear flows only; graph flows keep their actions inside the graph */
    actions: z.array(Action).max(10).default([]),
    /** present = run the node graph instead of `conditions` + `actions` */
    graph: Graph.optional(),
    /** approve = text sends wait in the drafts list; auto = sent at once; dry = only logged. */
    mode: z.enum(["auto", "approve", "dry"]).default("approve"),
    maxAgeMinutes: z.number().int().min(1).max(10080).default(180),
    cooldownSeconds: z.number().int().min(0).max(604800).default(0),
    maxPerHour: z.number().int().min(1).max(1000).default(30),
    stopOnMatch: z.boolean().default(false),
    tz: z.string().max(60).refine(validTz, "unknown time zone").default("Asia/Riyadh"),
  })
  .refine((f) => f.graph || f.actions.length > 0, { path: ["actions"], message: "needs at least one action" })
  .refine((f) => !f.actions.some((a) => a.type === "delay"), { path: ["actions"], message: "a delay needs the node editor (open the flow in the builder and save it)" });
export type FlowInput = z.infer<typeof FlowInput>;
/** What the dashboard sends: defaults not filled in yet. */
export type FlowDraft = z.input<typeof FlowInput>;

export type Flow = FlowInput & { id: string; createdAt: number; updatedAt: number; /** ignore messages older than this (ms) */ activeFrom: number };

export type Draft = {
  id: string;
  account: string;
  flowId: string;
  flowName: string;
  chat: string;
  chatName?: string;
  text: string;
  replyTo?: string;
  /** what the draft answers, for context in the dashboard */
  about?: { id: string; text?: string; who?: string };
  createdAt: number;
  status: "pending" | "sent" | "rejected" | "failed";
  error?: string;
};

/** One step of a run. Condition checks, AI output and timings were not recorded before run details existed, so all of those are optional. */
export type LogStep = {
  type: string;
  ok: boolean;
  detail?: string;
  /** graph flows: the node this step belongs to */
  node?: string;
  /** how long the step took */
  ms?: number;
  /** the text an AI step produced (capped), so it can be read later without re-running */
  output?: string;
  /** condition node: each check and whether it passed */
  checks?: { field: string; op: string; value?: string; ok: boolean; note?: string }[];
};

export type LogEntry = {
  /** run id, for the details page; entries from before run details have none */
  id?: string;
  /** a run that continues one which paused at a delay: the id of the run it continues */
  resumed?: string;
  t: number;
  /** total time from the first step to the last */
  ms?: number;
  account: string;
  flow: string;
  name: string;
  chat: string;
  chatName?: string;
  msg?: string;
  /** first 100 characters of the message, for the list */
  text?: string;
  /** the message that started the run, kept longer than `text` */
  trigger?: { text?: string; sender?: string; senderName?: string; type?: string; direction?: string };
  status: "ok" | "draft" | "dry" | "error" | "skipped";
  note?: string;
  actions: LogStep[];
};

/** A run paused at a delay node, waiting to continue. */
export type Wait = {
  id: string;
  flow: string;
  /** the delay node; the run continues with what follows it */
  node: string;
  chat: string;
  /** the message that started the run (absent for scheduled flows) */
  msg?: string;
  createdAt: number;
  resumeAt: number;
  cancelOnReply: boolean;
  /** the run this one continues, for the details page */
  runId?: string;
  /** what earlier steps produced and later steps may use ({{ai}}) */
  vars: { ai?: string };
};
