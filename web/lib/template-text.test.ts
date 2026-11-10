import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplateText } from "./template-text";

test("renders header, filled body, footer and button labels", () => {
  const comps = [
    { type: "HEADER", format: "TEXT", text: "العرض على وشك ينتهي" },
    { type: "BODY", text: "هلا {{1}}، معك زينب من فريق زيادة" },
    { type: "FOOTER", text: "لا يفوتك العرض" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "فعّل العرض" }, { type: "QUICK_REPLY", text: "إيقاف" }] },
  ];
  assert.equal(renderTemplateText(comps, ["متجر لون"]), "*العرض على وشك ينتهي*\n\nهلا متجر لون، معك زينب من فريق زيادة\n\n_لا يفوتك العرض_\n\n[فعّل العرض] [إيقاف]");
});

test("a body without variables, a media header and a missing value", () => {
  assert.equal(renderTemplateText([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "اشتقنا لك" }]), "[image]\n\nاشتقنا لك");
  assert.equal(renderTemplateText([{ type: "BODY", text: "هلا {{1}} {{2}}" }], ["أ"]), "هلا أ {{2}}");
});

test("no body or no components gives null so callers fall back", () => {
  assert.equal(renderTemplateText(undefined), null);
  assert.equal(renderTemplateText([{ type: "FOOTER", text: "x" }]), null);
});
