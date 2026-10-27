import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store, type StoredMessage } from "./store";
import { MemoryRawKV } from "./wa/auth";
import { buildOverview, type OverviewAccount } from "./overview";
import { pushLog, saveDraft, saveWait } from "./flows/storage";
import type { LogEntry } from "./flows/types";

const NOW = Date.UTC(2026, 5, 1, 12, 30, 0); // 12:30 UTC
const HOUR = 3600_000;
const sec = (ms: number) => Math.floor(ms / 1000);

function account(id: string, label: string, over: Partial<OverviewAccount> = {}): OverviewAccount {
  return { id, label, kind: "personal", store: new Store(new MemoryKV(), `${id}:`), state: new MemoryRawKV(), paired: true, lastSync: sec(NOW) - 60, ...over };
}

let n = 0;
const msg = (waId: string, direction: "in" | "out", at: number, over: Partial<StoredMessage> = {}): StoredMessage => ({ id: `m${++n}`, waId, direction, type: "text", text: "x", timestamp: sec(at), ...over });

const run = (over: Partial<LogEntry>): LogEntry => ({ id: `r${++n}`, t: NOW - HOUR, account: "main", flow: "f1", name: "flow", chat: "a@s.whatsapp.net", status: "ok", actions: [], ...over });

test("overview: counts the last 24 hours, buckets them by hour, ignores older messages and reactions", async () => {
  const a = account("main", "main");
  const chat = "966500000001@s.whatsapp.net";
  const old = "966500000002@s.whatsapp.net";
  for (const m of [
    msg(chat, "in", NOW - 10 * 60_000), // this hour
    msg(chat, "in", NOW - 70 * 60_000), // previous hour
    msg(chat, "out", NOW - 70 * 60_000 + 1000),
    msg(chat, "in", NOW - 30 * HOUR), // outside the window
    msg(chat, "in", NOW - 5 * 60_000, { type: "reaction" }), // reactions are not messages
    msg(old, "in", NOW - 40 * HOUR), // a chat with nothing in the window is not active
  ]) {
    await a.store.saveMessage(m);
  }
  const o = await buildOverview([a], NOW);
  assert.equal(o.totals.messagesIn, 2);
  assert.equal(o.totals.messagesOut, 1);
  assert.equal(o.totals.activeChats, 1);
  assert.equal(o.hourly.length, 24);
  const last = o.hourly[23];
  assert.equal(last.t, Date.UTC(2026, 5, 1, 12));
  assert.deepEqual([last.in, last.out], [1, 0]);
  assert.deepEqual([o.hourly[22].in, o.hourly[22].out], [1, 1]);
  assert.equal(o.hourly.reduce((s, h) => s + h.in + h.out, 0), 3);
});

test("overview: pending drafts, run outcomes, recent errors and AI use are summed across numbers", async () => {
  const a = account("main", "الرئيسي");
  const b = account("work", "الشغل");
  await saveDraft(a.state, { account: "main", flowId: "f1", flowName: "ردود", chat: "a@s.whatsapp.net", chatName: "سارة", text: "أهلاً" });
  await saveDraft(b.state, { account: "work", flowId: "f2", flowName: "مبيعات", chat: "b@s.whatsapp.net", text: "تمام", status: "sent" }); // already sent: not pending
  await pushLog(a.state, [
    run({ status: "ok" }),
    run({ status: "draft" }),
    run({ status: "error", name: "يرد على الأسعار", chatName: "سارة", actions: [{ type: "webhook", ok: false, detail: "webhook answered 500" }], t: NOW - 2 * HOUR }),
    run({ status: "ok", t: NOW - 30 * HOUR }), // outside the window
  ]);
  await pushLog(b.state, [run({ status: "error", account: "work", name: "فلو ثاني", note: "boom", t: NOW - 10 * 60_000 })]);
  await a.state.set("flow:ai:2026-06-01", "7");
  await b.state.set("flow:ai:2026-06-01", "5");
  await b.state.set("flow:ai:2026-05-31", "99"); // yesterday's counter must not count
  const o = await buildOverview([a, b], NOW);
  assert.equal(o.totals.drafts, 1);
  assert.equal(o.drafts[0].accountLabel, "الرئيسي");
  assert.deepEqual(o.totals.runs, { ok: 1, draft: 1, dry: 0, error: 2, skipped: 0 });
  assert.equal(o.totals.aiUsed, 12);
  assert.deepEqual(o.errors.map((e) => [e.name, e.detail]), [["فلو ثاني", "boom"], ["يرد على الأسعار", "webhook answered 500"]]);
  assert.equal(o.accounts.find((x) => x.id === "main")?.runs.error, 1);
});

test("overview: numbers keep their pairing state and an empty account is all zeros", async () => {
  const idle = account("main", "main", { paired: false, lastSync: null });
  const o = await buildOverview([idle], NOW);
  assert.equal(o.accounts[0].paired, false);
  assert.equal(o.accounts[0].lastSync, null);
  assert.deepEqual([o.totals.messagesIn, o.totals.messagesOut, o.totals.activeChats, o.totals.drafts, o.totals.aiUsed], [0, 0, 0, 0, 0]);
  assert.equal(o.hourly.every((h) => h.in === 0 && h.out === 0), true);
});

test("overview: runs waiting at a delay are counted per number and listed soonest first with the flow name", async () => {
  const a = account("main", "الرئيسي");
  const b = account("work", "الشغل");
  await a.store.setName("a@s.whatsapp.net", "سارة");
  const w = (flow: string, at: number, extra: object = {}) => ({ flow, node: "w", chat: "a@s.whatsapp.net", resumeAt: at, cancelOnReply: false, vars: {}, ...extra });
  await saveWait(a.state, w("f1", NOW + 2 * HOUR, { cancelOnReply: true }));
  await saveWait(a.state, w("f1", NOW - 5 * 60_000)); // already due: waiting for the next sync
  await saveWait(b.state, w("gone", NOW + HOUR));
  const o = await buildOverview([a, b], NOW, new Map([["f1", "متابعة العملاء"]]));
  assert.equal(o.totals.waiting, 3);
  assert.equal(o.accounts.find((x) => x.id === "main")?.waiting, 2);
  assert.deepEqual(o.waits.map((x) => [x.flowName, x.accountLabel]), [["متابعة العملاء", "الرئيسي"], ["gone", "الشغل"], ["متابعة العملاء", "الرئيسي"]]);
  assert.equal(o.waits[0].resumeAt < NOW, true, "the overdue one is first");
  assert.equal(o.waits[2].cancelOnReply, true);
  assert.equal(o.waits[0].chatName, "سارة");
});
