import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store } from "./store";
import { MemoryRawKV } from "./wa/auth";
import { testFlow, type Channel, type EngineDeps } from "./flows/engine";
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
