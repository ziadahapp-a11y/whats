import { admin, err } from "@/lib/admin";
import { target, targets } from "@/lib/inbox";
import { isPaired, MemoryRawKV } from "@/lib/wa/auth";
import { aiFromEnv, aiStatus, DEFAULT_MODEL, DEFAULT_REPLY_PROMPT } from "@/lib/flows/ai";
import { testFlow, type Channel } from "@/lib/flows/engine";
import { deleteFlow, deleteWait, isPaused, listFlows, listWaits, readLog, reorderFlows, saveFlow, setPaused } from "@/lib/flows/storage";
import { FIELDS, FlowInput, OPS, type Flow } from "@/lib/flows/types";
import { deleteHookSecret, hookSecret, rotateHookSecret } from "@/lib/flows/hooks";

const origin = (req: Request) => `https://${req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host}`;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const accounts = await targets(a);
  const runId = new URL(req.url).searchParams.get("run");
  const log = [];
  for (const row of accounts) {
    const t = await target(a, row.id);
    if (!t) continue;
    const rows = await readLog(t.state);
    if (runId) {
      const run = rows.find((l) => l.id === runId);
      if (!run) continue;
      const f = (await listFlows(a.base)).find((x) => x.id === run.flow);
      return Response.json({
        run: { ...run, accountLabel: row.label },
        // enough of the flow to draw it; `changed` warns when it was edited after this run
        flow: f && { id: f.id, name: f.name, trigger: f.trigger, match: f.match, conditions: f.conditions, actions: f.actions, graph: f.graph, changed: f.updatedAt > run.t },
      });
    }
    // the list only needs the one-line summary of each step; the details page fetches the rest
    log.push(...rows.map((l) => ({ ...l, trigger: undefined, accountLabel: row.label, actions: l.actions.map(({ output, checks, ...step }) => step) })));
  }
  if (runId) return err("Run not found. It may have expired from the log.", 404);
  return Response.json({
    flows: await listFlows(a.base),
    paused: await isPaused(a.base),
    ai: { configured: aiStatus().claude || aiStatus().cheap, claude: aiStatus().claude, cheap: aiStatus().cheap, cheapModel: aiStatus().cheapModel, model: process.env.AI_MODEL || DEFAULT_MODEL, dailyCap: Number(process.env.AI_MAX_PER_DAY) || 300, defaultPrompt: DEFAULT_REPLY_PROMPT },
    accounts,
    fields: FIELDS,
    ops: OPS,
    log: log.sort((x, y) => y.t - x.t).slice(0, 200),
  });
}

export async function PUT(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { flow } = (await req.json().catch(() => ({}))) as { flow?: unknown };
  try {
    const saved = await saveFlow(a.base, flow);
    if (saved.trigger.type === "webhook") await hookSecret(a.base, saved.id, true);
    return Response.json({ flow: saved });
  } catch (e) {
    return err(e, 400);
  }
}

export async function DELETE(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  await deleteFlow(a.base, id);
  await deleteHookSecret(a.base, id);
  return Response.json({ deleted: true });
}

// { op: "pause", paused } | { op: "reorder", ids } | { op: "test", flow, sample, useAi } | { op: "replay", run, useAi } | { op: "cancel_wait", account, id }
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  if (b.op === "pause") {
    await setPaused(a.base, !!b.paused);
    return Response.json({ paused: !!b.paused });
  }
  if (b.op === "reorder" && Array.isArray(b.ids)) {
    await reorderFlows(a.base, b.ids.map(String));
    return Response.json({ ok: true });
  }
  // { op: "replay", run, useAi }: runs the flow's current version on the message a past run saw, in dry mode.
  // The message, number and time all come from the stored run, never from the request.
  if (b.op === "replay") {
    const id = String(b.run ?? "");
    for (const row of await targets(a)) {
      const t = await target(a, row.id);
      if (!t) continue;
      const run = (await readLog(t.state)).find((l) => l.id === id);
      if (!run) continue;
      const f = (await listFlows(a.base)).find((x) => x.id === run.flow);
      if (!f) return err("This flow was deleted, so the run cannot be replayed.", 404);
      const me = t.kind === "personal" ? (await isPaired(t.state)).me?.split("@")[0].split(":")[0] : undefined;
      const channel: Channel = {
        account: t.id, kind: t.kind, me,
        sendText: async () => { throw new Error("replay only"); },
        react: async () => {},
        markRead: async () => {},
        resolveTarget: t.resolve,
      };
      const tr = run.trigger;
      const sample = run.chat
        ? { id: run.msg, timestamp: Math.floor(run.t / 1000), text: tr?.text ?? run.text ?? "", sender: tr?.sender, senderName: tr?.senderName ?? run.chatName, chat: run.chat, type: tr?.type, direction: tr?.direction === "out" ? ("out" as const) : ("in" as const) }
        : {};
      try {
        const result = await testFlow({ ...f, activeFrom: 0 }, sample, { flows: [], state: new MemoryRawKV(), store: t.store, channel, ai: b.useAi ? aiFromEnv() : undefined }, run.t);
        return Response.json({ ...result, changed: f.updatedAt > run.t });
      } catch (e) {
        return err(e);
      }
    }
    return err("Run not found. It may have expired from the log.", 404);
  }
  // { op: "cancel_wait", account, id }: drops a run that is waiting at a delay node, so its later steps never run.
  // { op: "hook", id } shows a webhook flow's address and secret; { op: "rotate_hook", id } replaces the secret.
  if (b.op === "hook" || b.op === "rotate_hook") {
    const f = (await listFlows(a.base)).find((x) => x.id === String(b.id ?? ""));
    if (!f || f.trigger.type !== "webhook") return err("Save the flow with a webhook trigger first.", 404);
    const secret = b.op === "rotate_hook" ? await rotateHookSecret(a.base, f.id) : await hookSecret(a.base, f.id, true);
    return Response.json({ url: `${origin(req)}/api/hooks/${f.id}`, secret });
  }
  if (b.op === "cancel_wait") {
    const t = await target(a, String(b.account ?? ""));
    if (!t) return err("Unknown number.", 404);
    const id = String(b.id ?? "");
    if (!(await listWaits(t.state)).some((w) => w.id === id)) return err("This waiting run is gone: it already continued, expired or was cancelled.", 404);
    await deleteWait(t.state, id);
    return Response.json({ cancelled: true });
  }
  if (b.op === "test") {
    const parsed = FlowInput.safeParse(b.flow);
    if (!parsed.success) return err(`Invalid flow: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`, 400);
    const now = Date.now();
    const flow: Flow = { ...parsed.data, id: "test", createdAt: now, updatedAt: now, activeFrom: 0 };
    const t = await target(a, flow.account === "*" ? "main" : flow.account);
    if (!t) return err("Unknown number.", 404);
    const me = t.kind === "personal" ? (await isPaired(t.state)).me?.split("@")[0].split(":")[0] : undefined;
    const channel: Channel = {
      account: t.id, kind: t.kind, me,
      sendText: async () => { throw new Error("test only"); },
      react: async () => {},
      markRead: async () => {},
      resolveTarget: t.resolve,
    };
    try {
      const result = await testFlow(flow, b.sample ?? {}, { flows: [], state: new MemoryRawKV(), store: t.store, channel, ai: b.useAi ? aiFromEnv() : undefined });
      return Response.json(result);
    } catch (e) {
      return err(e);
    }
  }
  return err("unknown op", 400);
}
