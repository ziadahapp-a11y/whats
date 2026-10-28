import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccount, checkCapacity, checkTemplate, normalizeSaudiMobile, preflight, screenRecipients, type RecipientRow } from "./preflight";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400_000;
const GOOD = { status: "CONNECTED", code_verification_status: "VERIFIED", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" };
const TPL = { name: "t", language: "ar", status: "APPROVED", category: "MARKETING", quality: "GREEN", paramCount: 1 };
const row = (over: Partial<RecipientRow> = {}): RecipientRow => ({ phone: "0500000001", consentSource: "dashboard", consentAt: "2026-09-01", params: ["أحمد"], ...over });
const ctx = (over = {}) => ({ now: NOW, optedOut: new Set<string>(), lastMarketingAt: new Map<string, number>(), paramCount: 1, ...over });

test("Saudi mobile numbers in every spelling normalise to 9665xxxxxxxx", () => {
  for (const ok of ["0501234567", "501234567", "+966 50 123 4567", "00966501234567", "٠٥٠١٢٣٤٥٦٧", "۰۵۰۱۲۳۴۵۶۷", "966501234567.0", "9660501234567", 501234567, "(050) 123-4567"]) {
    assert.equal(normalizeSaudiMobile(ok), "966501234567", String(ok));
  }
  for (const bad of ["0412345678", "+14155550123", "abc", "", "05012345", "96650123456789", null, undefined, {}]) {
    assert.equal(normalizeSaudiMobile(bad), null, String(bad));
  }
});

test("account checks fail closed", () => {
  assert.ok(checkAccount(GOOD).every((c) => c.ok));
  assert.equal(checkAccount(null)[0].ok, false);
  const bad = (over: object) => checkAccount({ ...GOOD, ...over }).filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(bad({ status: "PENDING" }), ["account.connected"]);
  assert.deepEqual(bad({ status: undefined }), ["account.connected"]);
  assert.deepEqual(bad({ code_verification_status: "NOT_VERIFIED" }), ["account.verified"]);
  assert.deepEqual(bad({ quality_rating: "YELLOW" }), ["account.quality"]);
  assert.deepEqual(bad({ quality_rating: "UNKNOWN" }), ["account.quality"]);
  assert.deepEqual(bad({ messaging_limit_tier: "TIER_BANANA" }), ["account.tier"]);
  assert.deepEqual(bad({ messaging_limit_tier: undefined }), ["account.tier"]);
});

test("template checks", () => {
  assert.ok(checkTemplate(TPL, "ar").every((c) => c.ok));
  assert.equal(checkTemplate(null, "ar")[0].ok, false);
  const bad = (over: object, lang = "ar") => checkTemplate({ ...TPL, ...over }, lang).filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(bad({ status: "PENDING" }), ["template.approved"]);
  assert.deepEqual(bad({ status: "PAUSED" }), ["template.approved"]);
  assert.deepEqual(bad({ category: "UTILITY" }), ["template.category"]);
  assert.deepEqual(bad({}, "en"), ["template.language"]);
  assert.deepEqual(bad({ quality: "RED" }), ["template.quality"]);
});

test("every recipient rule blocks with its own reason", () => {
  const c = ctx({ optedOut: new Set(["966500000002"]), lastMarketingAt: new Map([["966500000003", NOW - 2 * DAY]]) });
  const { accepted, blocked } = screenRecipients(
    [
      row(), // 1 ok
      row(), // 2 duplicate
      row({ phone: "0500000002" }), // 3 opted out
      row({ phone: "0500000003" }), // 4 cooldown
      row({ phone: "0500000004", consentSource: "" }), // 5
      row({ phone: "0500000005", consentAt: undefined }), // 6
      row({ phone: "0500000006", consentAt: "01/10/2026" }), // 7 ambiguous format
      row({ phone: "0500000007", consentAt: "2027-01-01" }), // 8 future
      row({ phone: "0500000008", consentAt: new Date(NOW - DAY) }), // 9 ok, a Date works
      row({ phone: "0500000009", params: [] }), // 10 missing param
      row({ phone: "0500000010", params: ["a\nb"] }), // 11 newline
      row({ phone: "0500000011", params: ["a    b"] }), // 12 four spaces
      row({ phone: "0500000012", params: ["  "] }), // 13 blank value
      row({ phone: "+14155550123" }), // 14 not Saudi
      row({ phone: "0500000013", consentAt: "2020-01-01" }), // 15 old consent is fine, there is no age limit
    ],
    c,
  );
  assert.deepEqual(accepted.map((a) => a.phone), ["966500000001", "966500000008", "966500000013"]);
  assert.deepEqual(
    blocked.map((b) => [b.row, b.reason]),
    [[2, "duplicate"], [3, "opted_out"], [4, "cooldown"], [5, "no_consent_source"], [6, "no_consent_date"], [7, "invalid_consent_date"], [8, "future_consent_date"], [10, "missing_param"], [11, "bad_param"], [12, "bad_param"], [13, "missing_param"], [14, "invalid_phone"]],
  );
});

test("cooldown ends after seven days", () => {
  const last = new Map([["966500000001", NOW - 7 * DAY - 1]]);
  assert.equal(screenRecipients([row()], ctx({ lastMarketingAt: last })).accepted.length, 1);
  const recent = new Map([["966500000001", NOW - 7 * DAY + 1000]]);
  assert.equal(screenRecipients([row()], ctx({ lastMarketingAt: recent })).blocked[0].reason, "cooldown");
});

test("capacity counts only new recipients and keeps a 20% margin", () => {
  const recent = new Set(["966500000001"]);
  const ok = checkCapacity("TIER_250", recent, ["966500000001", "966500000002"]); // limit 200, 1 already counted
  assert.equal(ok.check.ok, true);
  assert.equal(ok.newUnique, 1);
  assert.equal(ok.remaining, 199);
  const many = Array.from({ length: 200 }, (_, i) => `96650${String(i).padStart(7, "0")}`);
  assert.equal(checkCapacity("TIER_250", new Set(), many).check.ok, true);
  assert.equal(checkCapacity("TIER_250", new Set(), [...many, "966599999999"]).check.ok, false);
  assert.equal(checkCapacity("TIER_UNLIMITED", new Set(), many).check.ok, true);
  assert.equal(checkCapacity(undefined, new Set(), many).check.ok, false);
  assert.equal(checkCapacity("TIER_WHAT", new Set(), many).check.ok, false);
});

test("the combined report is ok only when everything passes and something can be sent", () => {
  const base = { phone: GOOD, template: TPL, language: "ar", now: NOW, optedOut: new Set<string>(), lastMarketingAt: new Map<string, number>(), recent24h: new Set<string>() };
  const good = preflight({ ...base, rows: [row(), row({ phone: "bad" })] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.summary, { total: 2, accepted: 1, blocked: 1, byReason: { invalid_phone: 1 }, newUnique: 1, remainingCapacity: 800 });

  assert.equal(preflight({ ...base, rows: [row({ phone: "bad" })] }).ok, false, "nothing sendable");
  assert.equal(preflight({ ...base, phone: { ...GOOD, quality_rating: "YELLOW" }, rows: [row()] }).ok, false);
  assert.equal(preflight({ ...base, phone: null, rows: [row()] }).ok, false);
  assert.equal(preflight({ ...base, template: null, rows: [row()] }).ok, false);
});
