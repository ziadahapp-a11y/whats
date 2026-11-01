import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCampaign, campaignReport, createDryRun, resumeCampaign, startCampaign, stopCampaign, type CampaignDeps, type DryRunRow } from "./campaign";
import { GraphError } from "./graph";
import { MemoryKV, Store } from "./store";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const TEMPLATE = { name: "summer_offer", language: "ar" };

type Sent = { to: string; payload: any };

function setup(opts: { tier?: string; quality?: string; components?: unknown[] } = {}) {
  const store = new Store(new MemoryKV());
  const g = {
    quality: opts.quality ?? "GREEN",
    sends: [] as Sent[],
    /** phone -> Meta error code the send should fail with */
    failFor: new Map<string, number>(),
    n: 0,
  };
  const graph = {
    phoneInfo: async () => ({ status: "CONNECTED", code_verification_status: "VERIFIED", quality_rating: g.quality, messaging_limit_tier: opts.tier ?? "TIER_1K" }),
    getTemplateInfo: async (name: string, language: string) => ({ name, language, status: "APPROVED", category: "MARKETING", quality: "GREEN", paramCount: 1 }),
    getTemplate: async () => ({ components: opts.components ?? [{ type: "BODY", text: "هلا {{1}}، عرض الصيف لك فقط" }] }),
    sendMessage: async (to: string, payload: any) => {
      const code = g.failFor.get(to);
      if (code) throw new GraphError(`failed ${code}`, 400, code);
      g.sends.push({ to, payload });
      return { messageId: `wamid.${++g.n}`, waId: to };
    },
  };
  const clock = { t: NOW };
  const deps: CampaignDeps = { graph: graph as any, store, now: () => clock.t, sleep: async () => {} };
  return { deps, store, g, clock };
}

const phone = (i: number) => `966${5}${String(i).padStart(8, "0")}`;
const rows = (n: number, from = 1): DryRunRow[] =>
  Array.from({ length: n }, (_, k) => ({ phone: `0${5}${String(from + k).padStart(8, "0")}`, consentSource: "dashboard", consentAt: "2026-09-01", params: [`عميل${from + k}`], sourceRow: from + k + 1 }));

/** Dry run, start, and return the id; asserts the dry run passed. */
async function started(t: ReturnType<typeof setup>, n: number) {
  const dry = await createDryRun(t.deps, { template: TEMPLATE, rows: rows(n) });
  assert.equal(dry.ok, true, JSON.stringify(dry.checks.filter((c) => !c.ok)));
  const s = await startCampaign(t.deps, dry.campaignId!, dry.confirmToken!);
  assert.equal(s.ok, true);
  return dry.campaignId!;
}

const fast = { pilotWaitMs: 0, budgetMs: 10_000 };

test("dry run saves a campaign with a token and sends nothing", async () => {
  const t = setup();
  const dry = await createDryRun(t.deps, { template: TEMPLATE, rows: [...rows(10), { phone: "123", consentSource: "dashboard", consentAt: "2026-09-01", params: ["x"], sourceRow: 99 }] });
  assert.equal(dry.ok, true);
  assert.ok(dry.campaignId && dry.confirmToken);
  assert.equal(dry.summary.accepted, 10);
  assert.deepEqual(dry.blocked.map((b) => [b.reason, b.sourceRow]), [["invalid_phone", 99]]);
  assert.equal(dry.pilotSize, 5);
  assert.equal(t.g.sends.length, 0);
  const report = await campaignReport(t.deps, dry.campaignId!);
  assert.equal(report?.status, "dry_run");
});

test("a failing check returns no campaign and no token", async () => {
  const yellow = await createDryRun(setup({ quality: "YELLOW" }).deps, { template: TEMPLATE, rows: rows(3) });
  assert.equal(yellow.ok, false);
  assert.equal(yellow.campaignId, undefined);
  assert.ok(yellow.checks.some((c) => c.id === "account.quality" && !c.ok));

  const media = await createDryRun(setup({ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x {{1}} y" }] }).deps, { template: TEMPLATE, rows: rows(3) });
  assert.ok(media.checks.some((c) => c.id === "send.media" && !c.ok));

  const location = await createDryRun(setup({ components: [{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "x {{1}} y" }] }).deps, { template: TEMPLATE, rows: rows(3) });
  assert.ok(location.checks.some((c) => c.id === "template.components" && !c.ok));

  const small = await createDryRun(setup({ tier: "TIER_250" }).deps, { template: TEMPLATE, rows: rows(300) }); // 250 less the 20% margin is 200
  assert.equal(small.ok, false);
  assert.ok(small.checks.some((c) => c.id === "capacity" && !c.ok));
});

const RICH = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "هلا {{1}}، عرض الصيف لك" },
  { type: "BUTTONS", buttons: [{ type: "URL", text: "ثبّت", url: "https://apps.salla.sa/{{1}}" }, { type: "QUICK_REPLY", text: "إيقاف" }] },
];

test("a media header, header value and link value are checked in the dry run", async () => {
  const noMedia = await createDryRun(setup({ components: RICH }).deps, { template: TEMPLATE, rows: rows(3) });
  assert.equal(noMedia.ok, false);
  assert.deepEqual(noMedia.checks.filter((c) => !c.ok).map((c) => c.id).sort(), ["send.button_var", "send.media"]);

  const wrongKind = await createDryRun(setup({ components: RICH }).deps, { template: TEMPLATE, rows: rows(3), send: { media: { kind: "video", link: "https://x.test/a.mp4" }, buttonParam: "ar/app/1" } });
  assert.ok(wrongKind.checks.some((c) => c.id === "send.media" && !c.ok));

  const http = await createDryRun(setup({ components: RICH }).deps, { template: TEMPLATE, rows: rows(3), send: { media: { kind: "image", link: "http://x.test/a.jpg" }, buttonParam: "ar/app/1" } });
  assert.ok(http.checks.some((c) => c.id === "send.media" && !c.ok));

  const spaced = await createDryRun(setup({ components: RICH }).deps, { template: TEMPLATE, rows: rows(3), send: { media: { kind: "image", link: "https://x.test/a.jpg" }, buttonParam: "a b" } });
  assert.ok(spaced.checks.some((c) => c.id === "send.button_var" && !c.ok));

  const extra = await createDryRun(setup().deps, { template: TEMPLATE, rows: rows(3), send: { media: { kind: "image", link: "https://x.test/a.jpg" } } });
  assert.ok(extra.checks.some((c) => c.id === "send.media" && !c.ok));

  const textHeader = [{ type: "HEADER", format: "TEXT", text: "عرض {{1}}" }, { type: "BODY", text: "هلا {{1}} اليوم" }];
  const partial = await createDryRun(setup({ components: textHeader }).deps, { template: TEMPLATE, rows: rows(3).map((r, i) => (i === 1 ? r : { ...r, headerParam: "خاص" })) });
  assert.ok(partial.checks.some((c) => c.id === "send.header_var" && !c.ok && c.message.includes("rows 3")));
  const long = await createDryRun(setup({ components: textHeader }).deps, { template: TEMPLATE, rows: rows(3), send: { headerText: "x".repeat(61) } });
  assert.ok(long.checks.some((c) => c.id === "send.header_var" && !c.ok));
});

test("the send carries the media header, per-row header and link values, with form fallbacks", async () => {
  const t = setup({ components: [{ type: "HEADER", format: "TEXT", text: "عرض {{1}}" }, ...RICH.slice(1)] });
  const list = rows(6).map((r, i) => (i === 0 ? { ...r, headerParam: " خاص ", buttonParam: "ar/app/9" } : r));
  const dry = await createDryRun(t.deps, { template: TEMPLATE, rows: list, send: { headerText: "الصيف", buttonParam: "ar/app/1099604538", media: { kind: "image", link: " " } } });
  assert.equal(dry.ok, true, JSON.stringify(dry.checks.filter((c) => !c.ok)));
  assert.equal((await startCampaign(t.deps, dry.campaignId!, dry.confirmToken!)).ok, true);
  await advanceCampaign(t.deps, dry.campaignId!, fast);
  assert.ok(t.g.sends.length >= 2); // the pilot goes first
  const first = t.g.sends[0].payload.template.components;
  assert.deepEqual(first[0], { type: "header", parameters: [{ type: "text", text: "خاص" }] });
  assert.deepEqual(first[1], { type: "body", parameters: [{ type: "text", text: "عميل1" }] });
  assert.deepEqual(first[2], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ar/app/9" }] });
  const second = t.g.sends[1].payload.template.components;
  assert.equal(second[0].parameters[0].text, "الصيف");
  assert.equal(second[2].parameters[0].text, "ar/app/1099604538");

  const d = setup({ components: [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "هلا {{1}} اليوم" }] });
  const dd = await createDryRun(d.deps, { template: TEMPLATE, rows: rows(5), send: { media: { kind: "document", id: "media-1", filename: "عرض.pdf" } } });
  assert.equal(dd.ok, true, JSON.stringify(dd.checks.filter((c) => !c.ok)));
  await startCampaign(d.deps, dd.campaignId!, dd.confirmToken!);
  await advanceCampaign(d.deps, dd.campaignId!, fast);
  assert.deepEqual(d.g.sends[0].payload.template.components[0], { type: "header", parameters: [{ type: "document", document: { id: "media-1", filename: "عرض.pdf" } }] });
});

test("start needs the right token, once", async () => {
  const t = setup();
  const dry = await createDryRun(t.deps, { template: TEMPLATE, rows: rows(10) });
  const bad = await startCampaign(t.deps, dry.campaignId!, "nope");
  assert.equal(bad.ok, false);
  assert.equal((await startCampaign(t.deps, dry.campaignId!, dry.confirmToken!)).ok, true);
  const again = await startCampaign(t.deps, dry.campaignId!, dry.confirmToken!);
  assert.equal(again.ok, false);
  t.clock.t += 25 * 60 * 60 * 1000;
  const t2 = setup();
  const old = await createDryRun(t2.deps, { template: TEMPLATE, rows: rows(10) });
  t2.clock.t += 25 * 60 * 60 * 1000;
  const expired = await startCampaign(t2.deps, old.campaignId!, old.confirmToken!);
  assert.equal(expired.ok, false);
  assert.match((expired as any).error, /24 hours/);
});

test("start re-checks: an opt-out after the dry run is dropped", async () => {
  const t = setup();
  const dry = await createDryRun(t.deps, { template: TEMPLATE, rows: rows(10) });
  await t.store.recordOptOut(phone(3), "stop", NOW - 1000);
  const s = await startCampaign(t.deps, dry.campaignId!, dry.confirmToken!);
  assert.equal(s.ok, true);
  assert.equal((s as any).campaign.total, 9);
});

test("runs a pilot, waits, then finishes and frees the account", async () => {
  const t = setup();
  const id = await started(t, 40);

  const first = await advanceCampaign(t.deps, id, { ...fast, pilotWaitMs: 60_000 });
  assert.equal(first.status, "waiting");
  assert.equal(t.g.sends.length, 5, "only the pilot batch goes out");

  const early = await advanceCampaign(t.deps, id, { ...fast, pilotWaitMs: 60_000 });
  assert.equal(early.status, "waiting");
  assert.equal(t.g.sends.length, 5, "nothing is sent before the wait is over");

  t.clock.t += 61_000;
  const done = await advanceCampaign(t.deps, id, fast);
  assert.equal(done.status, "completed");
  assert.equal(t.g.sends.length, 40);
  assert.deepEqual(t.g.sends[0].payload.template, { name: "summer_offer", language: { code: "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: "عميل1" }] }] });

  assert.equal((await t.store.lastMarketing([phone(1), phone(40)])).size, 2, "sends are recorded for cooldown and capacity");
  assert.equal((await t.store.recentMarketing(24 * 3600_000, t.clock.t)).size, 40);
  assert.equal((await t.store.messages(phone(1)))[0].type, "template");

  const next = await createDryRun(t.deps, { template: TEMPLATE, rows: rows(3, 100) });
  assert.equal(next.ok, true, "the account is free for another campaign");
});

test("only one campaign can hold the account", async () => {
  const t = setup();
  await started(t, 10);
  const second = await createDryRun(t.deps, { template: TEMPLATE, rows: rows(3, 100) });
  assert.equal(second.ok, false);
  assert.ok(second.checks.some((c) => c.id === "campaign.active"));
});

test("the breaker halts on a high failure rate and keeps the rest unsent", async () => {
  const t = setup();
  for (let i = 6; i <= 12; i++) t.g.failFor.set(phone(i), 131026); // 7 undeliverable numbers right after the pilot
  const id = await started(t, 60);
  await advanceCampaign(t.deps, id, fast); // pilot
  const v = await advanceCampaign(t.deps, id, fast);
  assert.equal(v.status, "halted");
  assert.match(v.haltReason!, /failed/);
  assert.equal(v.cursor, 20, "stopped as soon as 20 attempts made the rate count");
  assert.equal(v.sent + v.failed, 20);
  const again = await advanceCampaign(t.deps, id, fast);
  assert.equal(again.status, "halted");
  assert.equal(t.g.sends.length, 13, "nothing more goes out while halted");
});

test("a Meta spam or pace error halts at once, and resume needs GREEN", async () => {
  const t = setup();
  t.g.failFor.set(phone(3), 131048);
  const id = await started(t, 20);
  const v = await advanceCampaign(t.deps, id, fast);
  assert.equal(v.status, "halted");
  assert.equal(v.haltCode, 131048);
  assert.equal(v.cursor, 3);

  t.g.quality = "YELLOW";
  const refused = await resumeCampaign(t.deps, id);
  assert.equal(refused.ok, false);

  t.g.quality = "GREEN";
  assert.equal((await resumeCampaign(t.deps, id)).ok, true);
  let s = await advanceCampaign(t.deps, id, fast);
  while (s.status === "waiting" || s.status === "running") s = await advanceCampaign(t.deps, id, fast);
  assert.equal(s.status, "completed", "the old error does not halt it again");
  assert.equal(s.cursor, 20);
});

test("a quality drop between batches halts without sending", async () => {
  const t = setup();
  const id = await started(t, 40);
  await advanceCampaign(t.deps, id, fast); // pilot
  t.g.quality = "YELLOW";
  const v = await advanceCampaign(t.deps, id, fast);
  assert.equal(v.status, "halted");
  assert.match(v.haltReason!, /quality/i);
  assert.equal(t.g.sends.length, 5);
});

test("a failed delivery status from the webhook halts the campaign", async () => {
  const t = setup();
  const id = await started(t, 40);
  await advanceCampaign(t.deps, id, fast); // pilot: wamid.1..5
  await t.store.updateStatus("wamid.2", "failed", "131049: healthy ecosystem engagement");
  const v = await advanceCampaign(t.deps, id, fast);
  assert.equal(v.status, "halted");
  assert.equal(v.haltCode, 131049);
  assert.equal(t.g.sends.length, 5);
});

test("an opt-out during the campaign is skipped, and a send already on record is not repeated", async () => {
  const t = setup();
  const id = await started(t, 20);
  await t.store.recordOptOut(phone(7), "stop", t.clock.t);
  await t.store.recordMarketingSend(phone(9), t.clock.t + 5); // sent just before a crash
  let s = await advanceCampaign(t.deps, id, fast);
  while (s.status === "waiting" || s.status === "running") s = await advanceCampaign(t.deps, id, fast);
  assert.equal(s.status, "completed");
  assert.deepEqual(s.skippedBy, { opted_out: 1, already_sent: 1 });
  assert.equal(t.g.sends.length, 18);
  assert.ok(!t.g.sends.some((x) => x.to === phone(7) || x.to === phone(9)));
});

test("pause, resume and cancel", async () => {
  const t = setup();
  const id = await started(t, 40);
  await advanceCampaign(t.deps, id, { ...fast, pilotWaitMs: 60_000 });
  const paused = await stopCampaign(t.deps, id, "pause");
  assert.equal(paused.status, "halted");
  assert.equal(paused.haltReason, "Paused by a person.");
  const sent = t.g.sends.length;
  assert.equal((await advanceCampaign(t.deps, id, fast)).status, "halted");
  assert.equal(t.g.sends.length, sent);

  assert.equal((await resumeCampaign(t.deps, id)).ok, true);
  const cancelled = await stopCampaign(t.deps, id, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await advanceCampaign(t.deps, id, fast)).status, "cancelled");
  assert.equal((await createDryRun(t.deps, { template: TEMPLATE, rows: rows(3, 100) })).ok, true, "cancelling frees the account");
});

test("a stop request reaches a slice that is already running", async () => {
  const t = setup();
  const id = await started(t, 60);
  let first = true;
  const orig = t.deps.sleep!;
  t.deps.sleep = async (ms) => {
    if (first && t.g.sends.length === 3) {
      first = false;
      assert.equal((await stopCampaign(t.deps, id, "pause")).busy, true, "the running slice owns the lock");
    }
    return orig(ms);
  };
  const v = await advanceCampaign(t.deps, id, { ...fast, batch: 2 });
  assert.equal(v.status, "halted");
  assert.ok(t.g.sends.length < 10, "it stops at its next batch");
});

test("a second slice for the same campaign does nothing while one runs", async () => {
  const t = setup();
  const id = await started(t, 10);
  await t.store.mkLock(`tick:${id}`, 60);
  const v = await advanceCampaign(t.deps, id, fast);
  assert.equal(v.busy, true);
  assert.equal(t.g.sends.length, 0);
});

test("report counts delivery and masks numbers", async () => {
  const t = setup();
  t.g.failFor.set(phone(8), 131026);
  const id = await started(t, 12);
  let s = await advanceCampaign(t.deps, id, fast);
  while (s.status === "waiting" || s.status === "running") s = await advanceCampaign(t.deps, id, fast);
  await t.store.updateStatus("wamid.1", "delivered");
  await t.store.updateStatus("wamid.2", "read");
  const r = (await campaignReport(t.deps, id))!;
  assert.equal(r.status, "completed");
  assert.equal(r.sent, 11);
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 2);
  assert.equal(r.read, 1);
  assert.equal(r.pending, 9);
  assert.deepEqual(r.errors, [{ code: 131026, count: 1, meaning: undefined }]);
  assert.match(r.failureSample[0].phone, /^96650\*{4}\d{3}$/);
});
