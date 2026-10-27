import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRawKV } from "./wa/auth";
import { PER_MINUTE, deleteHookSecret, firstUse, hookSecret, parseHookBody, rotateHookSecret, sign, takeRate, verify } from "./flows/hooks";

const NOW_S = 1_790_000_000;

test("hooks: a correct signature passes; a changed body, wrong secret, missing or odd headers do not", () => {
  const body = JSON.stringify({ text: "طلب جديد" });
  const sig = sign("whsec_a", NOW_S, body);
  assert.equal(verify("whsec_a", String(NOW_S), sig, body, NOW_S), "ok");
  assert.equal(verify("whsec_a", String(NOW_S), sig, body + " ", NOW_S), "bad");
  assert.equal(verify("whsec_b", String(NOW_S), sig, body, NOW_S), "bad");
  assert.equal(verify("whsec_a", null, sig, body, NOW_S), "bad");
  assert.equal(verify("whsec_a", String(NOW_S), null, body, NOW_S), "bad");
  assert.equal(verify("whsec_a", "12abc", sig, body, NOW_S), "bad");
  assert.equal(verify("whsec_a", String(NOW_S + 1), sig, body, NOW_S), "bad", "the timestamp is part of what is signed");
});

test("hooks: a request older or newer than 5 minutes is stale even with a valid signature", () => {
  const ts = NOW_S - 301;
  assert.equal(verify("s", String(ts), sign("s", ts, "{}"), "{}", NOW_S), "stale");
  const ok = NOW_S - 299;
  assert.equal(verify("s", String(ok), sign("s", ok, "{}"), "{}", NOW_S), "ok");
});

test("hooks: the same request cannot be used twice, and each flow is rate limited per minute", async () => {
  const base = new MemoryRawKV();
  const sig = sign("s", NOW_S, "{}");
  assert.equal(await firstUse(base, "f1", sig), true);
  assert.equal(await firstUse(base, "f1", sig), false);
  assert.equal(await firstUse(base, "f2", sig), true, "per flow");
  const t = NOW_S * 1000;
  for (let i = 0; i < PER_MINUTE; i++) assert.equal(await takeRate(base, "f1", t), true);
  assert.equal(await takeRate(base, "f1", t), false);
  assert.equal(await takeRate(base, "f2", t), true, "other flows are not affected");
  assert.equal(await takeRate(base, "f1", t + 60_000), true, "the next minute starts again");
});

test("hooks: one secret per flow, stable until rotated, gone with the flow", async () => {
  const base = new MemoryRawKV();
  assert.equal(await hookSecret(base, "f1"), null, "nothing is created by just reading");
  const a = await hookSecret(base, "f1", true);
  assert.match(a ?? "", /^whsec_[0-9a-f]{48}$/);
  assert.equal(await hookSecret(base, "f1", true), a);
  const b = await rotateHookSecret(base, "f1");
  assert.notEqual(b, a);
  assert.equal(await hookSecret(base, "f1"), b);
  await deleteHookSecret(base, "f1");
  assert.equal(await hookSecret(base, "f1"), null);
});

test("hooks: the body gives to, text and flat data fields; bad bodies get a clear error", () => {
  assert.deepEqual(parseHookBody(""), { to: undefined, text: undefined, data: {} });
  assert.deepEqual(parseHookBody(JSON.stringify({ to: 966500000001, text: " شحنتك وصلت ", data: { order: 1234, paid: true, nested: { x: 1 }, none: null } })), {
    to: "966500000001",
    text: "شحنتك وصلت",
    data: { order: "1234", paid: "true" },
  });
  assert.throws(() => parseHookBody("nope"), /JSON/);
  assert.throws(() => parseHookBody("[1]"), /object/);
  assert.throws(() => parseHookBody(JSON.stringify({ text: "x".repeat(4097) })), /longer than 4096/);
  assert.throws(() => parseHookBody(JSON.stringify({ to: { a: 1 } })), /to must be a string/);
  assert.throws(() => parseHookBody(JSON.stringify({ data: { "bad-name": 1 } })), /letters, digits/);
  assert.throws(() => parseHookBody(JSON.stringify({ data: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })), /more than 20/);
});
