import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store, type StoredMessage } from "./store";
import { MemoryRawKV } from "./wa/auth";
import { runFlows, testFlow, type Channel, type EngineDeps } from "./flows/engine";
import { FlowInput, type Flow } from "./flows/types";
import { exportFlows, parseImport } from "./flows/portable";
import { surveyFlows, TAG } from "./survey-flows";

const NOW = 1_790_000_000_000;
const CHAT = "966500000001@s.whatsapp.net";

const channel: Channel = {
  account: "official", kind: "official", me: "966500000099",
  sendText: async () => "out1",
  react: async () => {},
  markRead: async () => {},
  resolveTarget: (to) => (to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`),
};

const flows: Flow[] = surveyFlows().map((f) => ({ ...FlowInput.parse(f), id: f.name, createdAt: NOW, updatedAt: NOW, activeFrom: 0 }) as Flow);
const byName = (part: string) => flows.find((f) => f.name.includes(part))!;

function fixture() {
  const state = new MemoryRawKV();
  const deps: EngineDeps = { flows: [], state, store: new Store(new MemoryKV(), "p:"), channel };
  return { deps, state };
}

async function step(part: string, sample: { text?: string; type?: string }, tags: string[]) {
  const { deps } = fixture();
  return testFlow(byName(part), { text: sample.text ?? "", type: sample.type ?? "text", chat: CHAT, sender: "966500000001", tags }, deps, NOW);
}

test("the survey starts only on a word of its own, once", async () => {
  assert.equal((await step("بدء", { text: "تم ✅" }, [])).matched, true);
  assert.equal((await step("بدء", { text: "تم." }, [])).matched, true);
  assert.equal((await step("بدء", { text: "تماماً" }, [])).matched, false, "تماماً is not تم");
  assert.equal((await step("بدء", { text: "تم" }, [TAG.wait])).matched, false, "already in the survey");
});

test("each choice gets its own answer and category", async () => {
  assert.equal((await step("الخيار 1", { text: "1" }, [TAG.wait])).matched, true);
  assert.equal((await step("الخيار 2", { text: "2" }, [TAG.wait])).matched, true);
  assert.equal((await step("الخيار 3", { text: "3 نعم" }, [TAG.wait])).matched, true);
  assert.equal((await step("الخيار 2", { text: "2" }, [TAG.wait])).matched, true);
  assert.equal((await step("الخيار 1", { text: "2" }, [TAG.wait])).matched, false);
  assert.equal((await step("الخيار 1", { text: "1" }, [TAG.wait, TAG.answered])).matched, false, "answered once");
});

test("a side question during the choice gets the AI answer, a choice never does", async () => {
  assert.equal((await step("أسئلة", { text: "كم سعر الباقة؟" }, [TAG.wait])).matched, true);
  assert.equal((await step("أسئلة", { text: "2" }, [TAG.wait])).matched, false);
  assert.equal((await step("أسئلة", { text: "تم" }, [TAG.wait])).matched, false);
});

test("the file is taken from a document, and any other message gets the format reminder", async () => {
  const waiting = [TAG.wait, TAG.answered, TAG.file];
  assert.equal((await step("استلام", { type: "document" }, waiting)).matched, true);
  assert.equal((await step("تذكير", { text: "ابي اعرف" }, waiting)).matched, true);
  assert.equal((await step("استلام", { text: "ابي اعرف" }, waiting)).matched, false);
  assert.equal((await step("استلام", { type: "document" }, [...waiting, TAG.received])).matched, false, "already received");
});

test("the flows survive the export and import round trip, and the import warns that they start as drafts", () => {
  const back = parseImport(JSON.stringify(exportFlows(flows)));
  assert.equal(back.flows.length, flows.length);
  assert.equal((back.flows[0]?.actions ?? [])[0]?.type, "reply");
  assert.ok(back.warnings.some((w) => w.includes("مسودة")));
});

function live(over: Partial<EngineDeps> = {}) {
  const sent: string[] = [];
  const ch: Channel = { ...channel, sendText: async (_chat, text) => (sent.push(text), "out" + sent.length) };
  const state = new MemoryRawKV();
  const deps: EngineDeps = { flows: surveyFlows().map((f) => ({ ...FlowInput.parse(f), id: f.name, createdAt: NOW, updatedAt: NOW, activeFrom: 0 }) as Flow), state, store: new Store(new MemoryKV(), "p:"), channel: ch, ...over };
  return { deps, sent, state };
}

function incoming(id: string, text: string, later = 0): StoredMessage {
  return { id, waId: CHAT, direction: "in", type: "text", text, timestamp: Math.floor(NOW / 1000) + later, sender: "966500000001", senderName: "Sara" };
}

test("a failing AI answer sends nothing to the merchant; the survey stays on the choice", async () => {
  let aiCalls = 0;
  const { deps, sent } = live({ ai: async () => { aiCalls++; throw new Error("model down"); } });
  const start = incoming("s1", "تم");
  await deps.store.saveMessage(start);
  await runFlows(deps, [start], NOW);
  assert.equal(sent.length, 1, "the intro is sent");

  const question = incoming("q1", "كم سعر الباقة؟", 60);
  await deps.store.saveMessage(question);
  const logs = await runFlows(deps, [question], NOW);
  assert.equal(aiCalls, 1, "the model was actually asked");
  assert.equal(sent.length, 1, "nothing is sent when the AI call throws");
  assert.ok(logs.length > 0, "the run is logged");
});

test("two 'تم' arriving together start the survey once", async () => {
  const { deps, sent } = live();
  const a = incoming("t1", "تم");
  const b = incoming("t2", "تم ✅", 1);
  await deps.store.saveMessage(a);
  await deps.store.saveMessage(b);
  await Promise.all([runFlows(deps, [a], NOW), runFlows(deps, [b], NOW)]);
  assert.equal(sent.length, 1, "the intro must go out once");
});
