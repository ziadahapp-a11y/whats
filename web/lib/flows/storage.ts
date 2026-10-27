// Flow definitions live once per deployment; drafts, logs and queues live per number.

import { randomBytes } from "node:crypto";
import type { RawKV } from "../wa/auth";
import { FlowInput, type Draft, type Flow, type LogEntry, type Wait } from "./types";

const FLOWS = "meta:flows";
const PAUSED = "meta:flows-paused";
const MAX_FLOWS = 50;

function parseList<T>(v: string | null): T[] {
  if (!v) return [];
  try {
    const rows = JSON.parse(v);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function listFlows(base: RawKV): Promise<Flow[]> {
  return parseList<Flow>(await base.get(FLOWS));
}

/** Validates and stores a flow (new when it has no id). Throws a readable error for bad input. */
export async function saveFlow(base: RawKV, input: unknown, now = Date.now()): Promise<Flow> {
  const parsed = FlowInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid flow: ${issue.path.join(".") || "flow"} ${issue.message}`);
  }
  const flows = await listFlows(base);
  const data = parsed.data;
  const i = data.id ? flows.findIndex((f) => f.id === data.id) : -1;
  if (i < 0 && flows.length >= MAX_FLOWS) throw new Error(`At most ${MAX_FLOWS} flows.`);
  const prev = i >= 0 ? flows[i] : undefined;
  const flow: Flow = {
    ...data,
    id: prev?.id ?? "f" + randomBytes(5).toString("hex"),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    // A flow only reacts to messages that arrive after it was switched on.
    activeFrom: !prev || (!prev.enabled && data.enabled) ? now : prev.activeFrom,
  };
  if (i >= 0) flows[i] = flow;
  else flows.push(flow);
  await base.set(FLOWS, JSON.stringify(flows));
  return flow;
}

export async function deleteFlow(base: RawKV, id: string) {
  const flows = await listFlows(base);
  await base.set(FLOWS, JSON.stringify(flows.filter((f) => f.id !== id)));
}

export async function reorderFlows(base: RawKV, ids: string[]) {
  const flows = await listFlows(base);
  const rank = new Map(ids.map((id, i) => [id, i]));
  flows.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  await base.set(FLOWS, JSON.stringify(flows));
}

export async function isPaused(base: RawKV) {
  return (await base.get(PAUSED)) === "1";
}

export async function setPaused(base: RawKV, paused: boolean) {
  if (paused) await base.set(PAUSED, "1");
  else await base.del(PAUSED);
}

/** Enabled flows that apply to one number, in order. */
export async function flowsFor(base: RawKV, account: string): Promise<Flow[]> {
  return (await listFlows(base)).filter((f) => f.enabled && (f.account === "*" || f.account === account));
}

// ---------- per number: log, queue, drafts ----------

const LOG = "flow:log";
const QUEUE = "flow:queue";
const DRAFT = "flow:draft:";

export async function readLog(state: RawKV): Promise<LogEntry[]> {
  return parseList<LogEntry>(await state.get(LOG));
}

export async function pushLog(state: RawKV, entries: LogEntry[], keep = 300) {
  if (!entries.length) return;
  const old = await readLog(state);
  await state.set(LOG, JSON.stringify([...entries.reverse(), ...old].slice(0, keep)), { ex: 30 * 86400 });
}

export async function readQueue(state: RawKV): Promise<string[]> {
  return parseList<string>(await state.get(QUEUE));
}

export async function writeQueue(state: RawKV, ids: string[]) {
  if (ids.length) await state.set(QUEUE, JSON.stringify(ids.slice(-300)), { ex: 7 * 86400 });
  else await state.del(QUEUE);
}

export async function saveDraft(state: RawKV, d: Omit<Draft, "id" | "createdAt" | "status"> & Partial<Draft>): Promise<Draft> {
  const draft: Draft = { id: randomBytes(6).toString("hex"), createdAt: Date.now(), status: "pending", ...d };
  await state.set(DRAFT + draft.id, JSON.stringify(draft), { ex: 30 * 86400 });
  return draft;
}

export async function getDraft(state: RawKV, id: string): Promise<Draft | null> {
  const v = await state.get(DRAFT + id);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export async function updateDraft(state: RawKV, draft: Draft) {
  await state.set(DRAFT + draft.id, JSON.stringify(draft), { ex: 30 * 86400 });
}

export async function listDrafts(state: RawKV, status?: Draft["status"]): Promise<Draft[]> {
  const names = state.keys ? await state.keys(DRAFT + "*") : [];
  const rows = await Promise.all(names.map((n) => getDraft(state, n.slice(DRAFT.length))));
  return rows.filter((d): d is Draft => !!d && (!status || d.status === status)).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- runs waiting at a delay node ----------

const WAIT = "flow:wait:";
const WAIT_TTL = 30 * 86400;
/** Per number. Each waiting run is one small key, so this keeps a busy chat from filling Redis. */
export const MAX_WAITS = 300;

export async function saveWait(state: RawKV, w: Omit<Wait, "id" | "createdAt"> & Partial<Pick<Wait, "createdAt">>): Promise<Wait> {
  const wait: Wait = { id: randomBytes(6).toString("hex"), createdAt: Date.now(), ...w };
  await state.set(WAIT + wait.id, JSON.stringify(wait), { ex: WAIT_TTL });
  return wait;
}

export async function listWaits(state: RawKV): Promise<Wait[]> {
  const names = state.keys ? await state.keys(WAIT + "*") : [];
  const rows = await Promise.all(
    names.map(async (n) => {
      try {
        return JSON.parse((await state.get(n)) ?? "null") as Wait | null;
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((w): w is Wait => !!w && !!w.id).sort((a, b) => a.resumeAt - b.resumeAt);
}

export async function deleteWait(state: RawKV, id: string) {
  await state.del(WAIT + id);
}
