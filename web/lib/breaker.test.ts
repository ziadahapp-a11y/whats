import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BREAKER, HALT_CODES, evaluate, parseErrorCode, type Outcome } from "./breaker";

const ok = (i: number): Outcome => ({ phone: `96650000${String(i).padStart(4, "0")}`, at: i, ok: true, messageId: `m${i}` });
const bad = (i: number, errorCode?: number): Outcome => ({ phone: `96650000${String(i).padStart(4, "0")}`, at: i, ok: false, errorCode });
const run = (okCount: number, badCount: number, code?: number) => [...Array.from({ length: okCount }, (_, i) => ok(i)), ...Array.from({ length: badCount }, (_, i) => bad(100 + i, code))];

test("error codes come out of the stored status text", () => {
  assert.equal(parseErrorCode("131048: Spam rate limit hit"), 131048);
  assert.equal(parseErrorCode("190: expired"), 190);
  assert.equal(parseErrorCode("boom"), undefined);
  assert.equal(parseErrorCode(undefined), undefined);
  assert.equal(parseErrorCode("The 131048 appears later"), undefined);
});

test("anything but GREEN halts, including an unknown rating", () => {
  assert.deepEqual(evaluate([], "GREEN"), { halt: false });
  for (const q of ["YELLOW", "RED", "UNKNOWN", undefined]) {
    const v = evaluate([], q);
    assert.equal(v.halt, true, String(q));
  }
});

test("each account, template and pace error halts on its own", () => {
  for (const code of Object.keys(HALT_CODES).map(Number)) {
    const v = evaluate([ok(1), bad(2, code)], "GREEN");
    assert.equal(v.halt, true, String(code));
    assert.equal(v.halt && v.code, code);
  }
});

test("per-recipient errors do not halt by themselves", () => {
  for (const code of [131026, 131050, 131021, 131030, undefined]) {
    assert.deepEqual(evaluate([ok(1), bad(2, code)], "GREEN"), { halt: false }, String(code));
  }
});

test("the failure rate halts only above the limit and after enough attempts", () => {
  assert.deepEqual(evaluate(run(0, 19), "GREEN"), { halt: false }, "19 attempts are too few to judge");
  assert.equal(evaluate(run(0, 20), "GREEN").halt, true);
  assert.deepEqual(evaluate(run(19, 1), "GREEN"), { halt: false }, "exactly 5% is not over the limit");
  assert.equal(evaluate(run(18, 2), "GREEN").halt, true, "10% is");
  assert.deepEqual(evaluate(run(1000, 50), "GREEN"), { halt: false }, "50 of 1050 is under 5%");
  const v = evaluate(run(18, 2), "GREEN");
  assert.equal(v.halt && /2 of 20/.test(v.reason), true);
});

test("a custom configuration is honoured", () => {
  const strict = { ...DEFAULT_BREAKER, maxFailureRate: 0.01, minAttempts: 5 };
  assert.equal(evaluate(run(4, 1), "GREEN", strict).halt, true);
  assert.deepEqual(evaluate(run(4, 1), "GREEN"), { halt: false });
  assert.equal(evaluate([], "YELLOW", { ...DEFAULT_BREAKER, requiredQuality: "YELLOW" }).halt, false);
});
