import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTemplate, lintTemplate, normalizeTemplateName, type TemplateDraft } from "./template-lint";

const good: TemplateDraft = {
  name: "summer_offer",
  language: "ar",
  header: { type: "TEXT", text: "عرض الصيف" },
  body: "هلا {{1}}، عندنا خصم خاص لك على جميع المنتجات لمدة محدودة، استخدم الكود {{2}} عند الدفع وخذ خصمك.",
  bodyExamples: ["أحمد", "SUMMER20"],
  footer: "منصة زيادة",
  buttons: [{ type: "QUICK_REPLY", text: "إيقاف" }],
};

const errors = (d: Partial<TemplateDraft>) => lintTemplate({ ...good, ...d }).filter((i) => i.level === "error");
const warnings = (d: Partial<TemplateDraft>) => lintTemplate({ ...good, ...d }).filter((i) => i.level === "warning");
const fields = (d: Partial<TemplateDraft>) => errors(d).map((i) => i.field);

test("a good template compiles to Meta's payload as MARKETING", () => {
  const r = compileTemplate(good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.paramCount, 2);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.payload, {
    name: "summer_offer",
    language: "ar",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "TEXT", text: "عرض الصيف" },
      { type: "BODY", text: good.body, example: { body_text: [["أحمد", "SUMMER20"]] } },
      { type: "FOOTER", text: "منصة زيادة" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "إيقاف" }] },
    ],
  });
});

test("names are normalised, and an unusable name is an error", () => {
  assert.deepEqual(["Summer Offer-2026", "  --x--  ", "عرض", "A__b"].map(normalizeTemplateName), ["summer_offer_2026", "x", "", "a_b"]);
  const r = compileTemplate({ ...good, name: "Summer Offer 2026" });
  assert.equal(r.ok && (r.payload.name as string), "summer_offer_2026");
  assert.equal(r.ok && r.warnings[0].field, "name");
  const empty = compileTemplate({ ...good, name: "عرض" });
  assert.equal(empty.ok, false);
  assert.deepEqual(!empty.ok && empty.issues.map((i) => i.field), ["name"]);
});

test("variable rules", () => {
  assert.ok(fields({ body: "{{1}} هلا بك في متجرنا الجديد ونتمنى لك تجربة ممتعة معنا", bodyExamples: ["a"] }).includes("body"), "cannot start with a variable");
  assert.ok(errors({ body: "هلا بك في متجرنا الجديد ونتمنى لك تجربة ممتعة معنا يا {{1}}", bodyExamples: ["a"] }).some((i) => /end/.test(i.message)));
  assert.ok(errors({ body: "هلا {{1}}{{2}} بك في متجرنا الجديد ونتمنى لك تجربة ممتعة معنا دائماً", bodyExamples: ["a", "b"] }).some((i) => /adjacent/.test(i.message)));
  assert.ok(errors({ body: "هلا {{1}} وهلا {{3}} بك في متجرنا الجديد ونتمنى لك تجربة ممتعة معنا دائماً", bodyExamples: ["a", "b"] }).some((i) => /gaps/.test(i.message)));
  assert.ok(errors({ body: "هلا {{name}} بك في متجرنا الجديد ونتمنى لك تجربة ممتعة معنا دائماً وأبداً", bodyExamples: [] }).some((i) => /malformed/.test(i.message)));
  assert.ok(errors({ body: "هلا {{1}} {{2}} {{3}} {{4}}", bodyExamples: ["a", "b", "c", "d"] }).some((i) => /too many variables/i.test(i.message)));
  assert.equal(errors({ body: "مرحباً بك في متجرنا الجديد، نتمنى لك تجربة ممتعة معنا دائماً وأبداً", bodyExamples: [] }).length, 0, "no variables is fine");
});

test("examples are required, complete and clean", () => {
  assert.deepEqual(fields({ bodyExamples: ["أحمد"] }), ["bodyExamples"]);
  assert.deepEqual(fields({ bodyExamples: ["a\nb", ""] }), ["bodyExamples[0]", "bodyExamples[1]"]);
  assert.deepEqual(fields({ bodyExamples: ["a    b", "x"] }), ["bodyExamples[0]"]);
});

test("length limits count characters, not bytes", () => {
  assert.ok(fields({ body: "ا".repeat(1025) }).includes("body"));
  assert.equal(errors({ body: "ا".repeat(1024), bodyExamples: [] }).length, 0);
  assert.ok(fields({ header: { type: "TEXT", text: "ا".repeat(61) } }).includes("header"));
  assert.ok(fields({ footer: "ا".repeat(61) }).includes("footer"));
  assert.ok(fields({ buttons: [{ type: "QUICK_REPLY", text: "ا".repeat(26) }] }).includes("buttons[0].text"));
});

test("language must match the text", () => {
  assert.deepEqual(fields({ language: "en" }), ["language"]);
  assert.deepEqual(fields({ language: "ar", body: "Hello {{1}}, we have a special discount for you on every product this week only, use code {{2}}.", header: undefined }), ["language"]);
  assert.ok(fields({ language: "arabic" }).includes("language"), "not a Meta language code");
});

test("header, footer and URLs", () => {
  assert.ok(fields({ header: { type: "TEXT", text: "عرض 🔥" } }).includes("header"));
  assert.ok(fields({ header: { type: "TEXT", text: "*عرض*" } }).includes("header"));
  assert.ok(fields({ header: { type: "TEXT", text: "عرض {{1}}" } }).includes("header"));
  assert.ok(fields({ header: { type: "IMAGE", handle: "" } }).includes("header"));
  assert.ok(fields({ footer: "تسوق {{1}}" }).includes("footer"));
  assert.ok(fields({ body: "اضغط على bit.ly/abc للحصول على العرض الجديد من متجرنا لفترة محدودة جداً فقط", bodyExamples: [] }).includes("body"));
  assert.equal(errors({ body: "زر موقعنا ant.com أو tco.sa للحصول على العرض الجديد من متجرنا لفترة محدودة", bodyExamples: [] }).length, 0, "similar domains are not shorteners");
});

test("button rules", () => {
  const url = (u: string, ex?: string) => [{ type: "URL" as const, text: "تسوق", url: u, urlExample: ex }];
  assert.deepEqual(fields({ buttons: url("http://a.com") }), ["buttons[0].url"]);
  assert.deepEqual(fields({ buttons: url("https://a.com/{{1}}") }), ["buttons[0].urlExample"]);
  assert.deepEqual(fields({ buttons: url("https://a.com/{{1}}", "https://a.com/x") }), []);
  assert.deepEqual(fields({ buttons: url("https://a.com/{{1}}/x") }), ["buttons[0].url"], "the variable is only allowed at the very end");
  assert.deepEqual(fields({ buttons: url("https://bit.ly/x") }), ["buttons[0].url"]);
  assert.deepEqual(fields({ buttons: [{ type: "PHONE_NUMBER", text: "اتصل", phone: "0500000000" }] }), ["buttons[0].phone"]);
  assert.deepEqual(fields({ buttons: [{ type: "QUICK_REPLY", text: "نعم" }, { type: "QUICK_REPLY", text: "نعم" }] }), ["buttons[1].text"]);
  const three = [1, 2, 3].map((n) => ({ type: "URL" as const, text: `رابط ${n}`, url: `https://a.com/${n}` }));
  assert.ok(fields({ buttons: three }).includes("buttons"));
  const eleven = Array.from({ length: 11 }, (_, n) => ({ type: "QUICK_REPLY" as const, text: `خيار ${n}` }));
  assert.ok(fields({ buttons: eleven }).includes("buttons"));
});

test("an opt-out button is recommended, not required", () => {
  assert.equal(warnings({ buttons: [] }).some((w) => w.field === "buttons"), true);
  assert.equal(warnings({}).length, 0);
});

test("buttons are emitted in Meta's grouping and dynamic URLs carry their example", () => {
  const r = compileTemplate({
    ...good,
    buttons: [
      { type: "PHONE_NUMBER", text: "اتصل", phone: "+966500000000" },
      { type: "URL", text: "تسوق", url: "https://a.com/{{1}}", urlExample: "https://a.com/summer" },
      { type: "QUICK_REPLY", text: "إيقاف" },
    ],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const buttons = (r.payload.components as any[]).find((c) => c.type === "BUTTONS").buttons;
  assert.deepEqual(buttons.map((b: any) => b.type), ["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
  assert.deepEqual(buttons[1].example, ["https://a.com/summer"]);
  assert.equal(buttons[2].phone_number, "+966500000000");
});

test("a template with no variables has no example block", () => {
  const r = compileTemplate({ ...good, body: "مرحباً بك في متجرنا الجديد، نتمنى لك تجربة ممتعة معنا دائماً وأبداً", bodyExamples: [] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.paramCount, 0);
  assert.equal((r.payload.components as any[]).find((c) => c.type === "BODY").example, undefined);
});
