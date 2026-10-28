import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store } from "./store";
import { OPT_OUT_CONFIRMATION, confirmOptOuts, ingest, optOutVia } from "./webhook";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const H = 3_600_000;
const D = 24 * H;

const msg = (id: string, from: string, text: string, type = "text") => ({ id, from, type, timestamp: "1793200000", ...(type === "text" ? { text: { body: text } } : { button: { text } }) });
const payload = (value: object) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, ...value } }] }] });

test("marketing state: opt-outs, last send and the 24-hour recipient set", async () => {
  const s = new Store(new MemoryKV());
  await s.recordOptOut("966500000002", "stop", NOW - D);
  await s.recordOptOut("966500000009", "stop", NOW - D);
  await s.recordOptIn("966500000009", NOW - H);
  await s.recordOptIn("966500000077", NOW); // never opted out: nothing to record
  assert.deepEqual([...(await s.optedOut(["966500000001", "966500000002", "966500000009"]))], ["966500000002"]);
  assert.deepEqual((await s.optOuts()).map((o) => o.phone), ["966500000002"]);

  await s.recordMarketingSend("966500000003", NOW - 2 * D);
  await s.recordMarketingSend("966500000004", NOW - 2 * H);
  await s.recordMarketingSend("966500000004", NOW - H); // same number again stays one member
  await s.recordMarketingSend("966500000005", NOW - 30 * H);
  assert.deepEqual([...(await s.lastMarketing(["966500000003", "966500000001", "966500000004"]))], [["966500000003", NOW - 2 * D], ["966500000004", NOW - H]]);
  assert.deepEqual([...(await s.recentMarketing(24 * H, NOW))], ["966500000004"]);
  assert.equal((await s.recentMarketing(7 * D, NOW)).size, 3);
});

test("marketing state tolerates empty lists, many numbers and bad input", async () => {
  const s = new Store(new MemoryKV());
  assert.equal((await s.optedOut([])).size, 0);
  assert.equal((await s.lastMarketing([])).size, 0);
  await assert.rejects(() => s.optedOut(["+966500000001"]), /normalised/);
  await assert.rejects(() => s.recordOptOut("12", "x"), /normalised/);
  const many = Array.from({ length: 1200 }, (_, i) => `9665${String(i).padStart(8, "0")}`); // more than one mget chunk
  for (const p of many.slice(0, 3)) await s.recordOptOut(p, "stop");
  assert.equal((await s.optedOut(many)).size, 3);
});

test("named locks are exclusive and expire", async () => {
  const s = new Store(new MemoryKV());
  assert.equal(await s.mkLock("a", 30), true);
  assert.equal(await s.mkLock("a", 30), false);
  assert.equal(await s.mkLock("b", 30), true);
  await s.mkUnlock("a");
  assert.equal(await s.mkLock("a", 1), true);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await s.mkLock("a", 30), true, "an expired lock can be taken again");
});

test("only a whole-message stop opts out", () => {
  for (const t of ["stop", "STOP!", "  Stop  ", "إيقاف", "ايقاف.", "إِيقَاف", "الغاء", "إلغاء", "توقف", "Unsubscribe", "🛑 stop"]) {
    assert.equal(optOutVia({ direction: "in", type: "text", text: t }), "keyword", t);
  }
  for (const t of ["don't stop sending offers", "لا توقف العروض", "stopping", "كم السعر", "", "stop it please"]) {
    assert.equal(optOutVia({ direction: "in", type: "text", text: t }), null, t);
  }
  assert.equal(optOutVia({ direction: "in", type: "button", text: "إيقاف" }), "button");
  assert.equal(optOutVia({ direction: "in", type: "interactive", text: "stop" }), "button");
  assert.equal(optOutVia({ direction: "in", type: "image", text: "stop" }), null);
  assert.equal(optOutVia({ direction: "out", type: "text", text: "stop" }), null);
});

test("the webhook records the opt-out and tells the flows to skip that message", async () => {
  const s = new Store(new MemoryKV());
  const body = payload({ messages: [msg("m1", "966500000001", "إيقاف"), msg("m2", "966500000002", "هلا"), msg("m3", "966500000003", "stop", "button")] });
  const a = await ingest(body, s, "PN1");
  assert.deepEqual(a.optOuts, [
    { waId: "966500000001", via: "message", messageId: "m1", repeat: false },
    { waId: "966500000003", via: "message", messageId: "m3", repeat: false },
  ]);
  assert.deepEqual([...(await s.optedOut(["966500000001", "966500000002", "966500000003"]))], ["966500000001", "966500000003"]);

  assert.deepEqual((await ingest(body, s, "PN1")).optOuts, [], "a redelivered webhook changes nothing");
  const again = await ingest(payload({ messages: [msg("m4", "966500000001", "stop")] }), s, "PN1");
  assert.deepEqual(again.optOuts, [{ waId: "966500000001", via: "message", messageId: "m4", repeat: true }]);
});

test("a failed save is retried without losing the opt-out", async () => {
  const kv = new MemoryKV();
  const s = new Store(kv);
  const real = s.saveMessage.bind(s);
  let failOnce = true;
  s.saveMessage = async (m) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("redis down");
    }
    return real(m);
  };
  const body = payload({ messages: [msg("m1", "966500000001", "stop")] });
  await assert.rejects(() => ingest(body, s, "PN1"), /redis down/);
  assert.equal((await s.optedOut(["966500000001"])).size, 1, "recorded before the save that failed");
  const retry = await ingest(body, s, "PN1"); // Meta redelivers
  assert.equal(retry.optOuts.length, 1);
  assert.equal(retry.optOuts[0].repeat, true, "known gap: the retry counts as a repeat, so this customer gets no confirmation, though the opt-out holds");
});

test("Meta's 131050 (the customer stopped marketing in WhatsApp) opts out without a reply", async () => {
  const s = new Store(new MemoryKV());
  const r = await ingest(
    payload({
      statuses: [
        { id: "o1", status: "failed", recipient_id: "966500000004", timestamp: "1793200100", errors: [{ code: 131050, title: "stopped marketing" }] },
        { id: "o2", status: "failed", recipient_id: "966500000005", errors: [{ code: 131026, title: "undeliverable" }] },
      ],
    }),
    s,
    "PN1",
  );
  assert.deepEqual(r.optOuts, [{ waId: "966500000004", via: "meta", repeat: false }]);
  assert.deepEqual([...(await s.optedOut(["966500000004", "966500000005"]))], ["966500000004"]);
  assert.match((await s.optOuts())[0].reason, /131050/);
});

test("a sender that is not a plain number is never recorded", async () => {
  const s = new Store(new MemoryKV());
  const r = await ingest(payload({ messages: [msg("m9", "abc", "stop")] }), s, "PN1");
  assert.equal(r.optOuts.length, 0);
  assert.equal(r.messages, 1);
});

test("the confirmation goes out once per stop and never throws", async () => {
  const s = new Store(new MemoryKV());
  const sent: string[] = [];
  const graph = {
    sendMessage: async (to: string, p: any) => {
      if (to === "966500000001") throw new Error("boom");
      sent.push(`${to}:${p.text.body === OPT_OUT_CONFIRMATION}`);
      return { messageId: `out-${to}`, waId: to };
    },
  };
  const silence = console.error;
  console.error = () => {};
  try {
    await confirmOptOuts(
      [
        { waId: "966500000001", via: "message", messageId: "a", repeat: false }, // send fails
        { waId: "966500000002", via: "message", messageId: "b", repeat: false },
        { waId: "966500000003", via: "message", messageId: "c", repeat: true }, // already opted out
        { waId: "966500000004", via: "meta", repeat: false }, // cannot be delivered anyway
      ],
      graph,
      s,
    );
  } finally {
    console.error = silence;
  }
  assert.deepEqual(sent, ["966500000002:true"]);
  assert.equal((await s.getMessage("out-966500000002"))?.text, OPT_OUT_CONFIRMATION);
  assert.equal(await s.getMessage("out-966500000001"), null);
});
