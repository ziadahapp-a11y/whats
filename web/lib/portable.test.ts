import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFlows, parseImport, FORMAT, VERSION } from "./flows/portable";
import { flowToGraph } from "./flows/graph";
import { FlowInput, type Flow } from "./flows/types";

const mk = (over: Record<string, unknown> = {}): Flow => {
  const f = FlowInput.parse({
    name: "رد على الأسعار",
    account: "work",
    enabled: true,
    mode: "auto",
    conditions: [{ field: "text", op: "contains_any", value: "سعر" }],
    actions: [{ type: "reply", text: "الأسعار في الرابط" }, { type: "webhook", url: "https://example.com/hook", headers: { Authorization: "Bearer SECRET-TOKEN" } }],
    cooldownSeconds: 30,
    ...over,
  });
  return { ...f, id: "f1abc", createdAt: 1, updatedAt: 2, activeFrom: 3 };
};

test("export: keeps the logic and limits, drops the id, number, state and header secrets", () => {
  const file = exportFlows([mk()], new Date("2026-06-01T00:00:00Z"));
  assert.equal(file.format, FORMAT);
  assert.equal(file.version, VERSION);
  assert.equal(file.exportedAt, "2026-06-01T00:00:00.000Z");
  const [f] = file.flows as Record<string, unknown>[];
  for (const k of ["id", "enabled", "account", "createdAt", "updatedAt", "activeFrom"]) assert.equal(k in f, false, `${k} must not be exported`);
  assert.equal(f.cooldownSeconds, 30);
  const json = JSON.stringify(file);
  assert.equal(json.includes("SECRET-TOKEN"), false, "header values must not leak");
  assert.match(json, /"Authorization":""/, "the header name stays as a reminder");
});

test("import: round trip keeps behaviour but always lands switched off, as drafts, on all numbers", () => {
  const text = JSON.stringify(exportFlows([mk()]));
  const { flows, warnings } = parseImport(text);
  assert.equal(flows.length, 1);
  const f = FlowInput.parse(flows[0]);
  assert.equal(f.enabled, false);
  assert.equal(f.mode, "approve");
  assert.equal(f.account, "*");
  assert.equal(f.id, undefined);
  assert.equal(f.name, "رد على الأسعار");
  assert.deepEqual(f.conditions, [{ field: "text", op: "contains_any", value: "سعر" }]);
  assert.equal(f.actions.length, 2);
  assert.ok(warnings.some((w) => w.includes("متوقفاً")));
  assert.ok(warnings.some((w) => w.includes("Webhook")));
});

test("import: a hostile file cannot enable a flow, pick auto mode or a number", () => {
  const hostile = { format: FORMAT, version: VERSION, flows: [{ name: "x", enabled: true, mode: "auto", account: "main", id: "evil", actions: [{ type: "reply", text: "hi" }], createdAt: 1, activeFrom: 0 }] };
  const [f] = parseImport(JSON.stringify(hostile)).flows;
  assert.deepEqual([f.enabled, f.mode, f.account, f.id], [false, "approve", "*", undefined]);
  assert.equal("createdAt" in f, false, "unknown keys are dropped");
});

test("import: graph flows and a bundle of several flows survive", () => {
  const linear = mk();
  const graphFlow = mk({ name: "شبكة", conditions: [], actions: [], graph: flowToGraph({ match: "all", conditions: [{ field: "text", op: "contains", value: "x" }], actions: [{ type: "reply", text: "a", quote: false }] }) });
  const { flows } = parseImport(JSON.stringify(exportFlows([linear, graphFlow])));
  assert.equal(flows.length, 2);
  assert.ok(FlowInput.parse(flows[1]).graph, "the graph is kept");
});

test("import: clear Arabic errors for the usual mistakes", () => {
  assert.throws(() => parseImport("not json"), /JSON/);
  assert.throws(() => parseImport(JSON.stringify({ hello: 1 })), /الصيغة/);
  assert.throws(() => parseImport(JSON.stringify({ format: FORMAT, version: 99, flows: [{}] })), /نسخة الملف/);
  assert.throws(() => parseImport(JSON.stringify({ format: FORMAT, version: VERSION, flows: [] })), /ما فيه فلوات/);
  assert.throws(() => parseImport(JSON.stringify({ format: FORMAT, version: VERSION, flows: [{ name: "bad", actions: [] }] })), /الفلو رقم 1 غير صالح/);
  assert.throws(() => parseImport(JSON.stringify({ format: FORMAT, version: VERSION, flows: Array.from({ length: 21 }, () => ({})) })), /أكثر من 20/);
  assert.throws(() => parseImport("x".repeat(300_001)), /كبير/);
});
