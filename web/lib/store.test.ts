import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryKV, Store } from "./store";
import { ingest, verifySignature } from "./webhook";
import { Graph, isBsuid, normalizePhone } from "./graph";
import { isAuthorized } from "./auth";

const now = 1_790_000_000;

function payload(messages: unknown[] = [], statuses: unknown[] = [], field = "messages", extra: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN1" }, contacts: [{ wa_id: "966500000001", profile: { name: "سارة" } }], messages, statuses, ...extra } }] }],
  };
}

test("signature verification", () => {
  const body = '{"a":1}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "s3cret"), true);
  assert.equal(verifySignature(body + " ", sig, "s3cret"), false);
  assert.equal(verifySignature(body, sig, ""), false);
  assert.equal(verifySignature(body, null, "s3cret"), false);
  assert.equal(verifySignature(body, "sha256=zz", "s3cret"), false);
});

test("ingest inbound text, media, statuses and window", async () => {
  const store = new Store(new MemoryKV());
  await ingest(
    payload([
      { from: "966500000001", id: "wamid.1", timestamp: String(now - 100), type: "text", text: { body: "مرحبا، عندكم توصيل؟" } },
      { from: "966500000001", id: "wamid.2", timestamp: String(now - 50), type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "هذا المنتج" } },
    ]),
    store,
    "PN1",
  );
  const msgs = await store.messages("966500000001");
  assert.deepEqual(msgs.map((m) => m.id), ["wamid.1", "wamid.2"]);
  assert.equal(msgs[1].mediaId, "MEDIA1");
  assert.equal(msgs[1].caption, "هذا المنتج");

  const [conv] = await store.conversations(10, undefined, now);
  assert.equal(conv.name, "سارة");
  assert.equal(conv.windowOpen, true);
  assert.equal((await store.window("966500000001", now + 25 * 3600)).windowOpen, false);

  // Outbound + statuses: out-of-order delivery must not downgrade "read".
  await store.saveMessage({ id: "wamid.out", waId: "966500000001", direction: "out", type: "text", text: "نعم", timestamp: now, status: "sent" });
  await ingest(payload([], [{ id: "wamid.out", status: "read" }]), store, "PN1");
  await ingest(payload([], [{ id: "wamid.out", status: "delivered" }]), store, "PN1");
  assert.equal((await store.getMessage("wamid.out"))?.status, "read");

  const hits = await store.search("توصيل");
  assert.equal(hits[0]?.id, "wamid.1");
});

test("status arriving before our own write is kept", async () => {
  const store = new Store(new MemoryKV());
  await ingest(payload([], [{ id: "wamid.fast", status: "delivered" }]), store, "PN1");
  await store.saveMessage({ id: "wamid.fast", waId: "966500000001", direction: "out", type: "text", timestamp: now, status: "sent" });
  assert.equal((await store.getMessage("wamid.fast"))?.status, "delivered");
});

test("other phone numbers on the WABA are ignored", async () => {
  const store = new Store(new MemoryKV());
  const stats = await ingest(payload([{ from: "1", id: "x", timestamp: String(now), type: "text", text: { body: "hi" } }]), store, "OTHER");
  assert.equal(stats.messages, 0);
});

test("coexistence echoes are stored as outgoing", async () => {
  const store = new Store(new MemoryKV());
  await ingest(payload([], [], "smb_message_echoes", { message_echoes: [{ from: "PN", to: "966500000002", id: "echo1", timestamp: String(now), type: "text", text: { body: "من الجوال" } }] }), store, "PN1");
  const [m] = await store.messages("966500000002");
  assert.equal(m.direction, "out");
  assert.equal(m.source, "business_app");
  assert.equal(m.text, "من الجوال");
});

test("customers Meta sends without a phone number are kept by their BSUID", async () => {
  const store = new Store(new MemoryKV());
  const body = payload([{ from_user_id: "SA.1234567890123456789", id: "bsuid1", timestamp: String(now), type: "text", text: { body: "هلا" } }], [], "messages", {
    contacts: [{ user_id: "SA.1234567890123456789", profile: { name: "زينب" } }],
  });
  const stats = await ingest(body, store, "PN1");
  assert.equal(stats.fresh[0].waId, "SA.1234567890123456789");
  const [c] = await store.conversations();
  assert.equal(c.waId, "SA.1234567890123456789");
  assert.equal(c.name, "زينب");
});

test("a message with no customer id at all is skipped", async () => {
  const store = new Store(new MemoryKV());
  const stats = await ingest(payload([{ id: "noid", timestamp: String(now), type: "text", text: { body: "?" } }], [], "messages", { contacts: [] }), store, "PN1");
  assert.equal(stats.messages, 0);
  assert.equal((await store.conversations()).length, 0);
});

test("replies to a BSUID go in recipient, phone numbers in to", async () => {
  const sent: any[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const graph = new Graph({ accessToken: "t", phoneNumberId: "PN1" } as any, fake);
  await graph.sendMessage("SA.1234567890123456789", { type: "text", text: { body: "a" } });
  await graph.sendMessage("+966 50 000 0001", { type: "text", text: { body: "b" } });
  assert.equal(sent[0].recipient, "SA.1234567890123456789");
  assert.equal(sent[0].to, undefined);
  assert.equal(sent[1].to, "966500000001");
  assert.equal(sent[1].recipient, undefined);
  assert.ok(isBsuid("US.13491208655302741918"));
  assert.ok(!isBsuid("966500000001"));
});

test("phone normalisation", () => {
  assert.equal(normalizePhone("+966 50-000 0001"), "966500000001");
  assert.throws(() => normalizePhone("123"));
});

test("MCP auth", () => {
  const secret = "x".repeat(32);
  assert.equal(isAuthorized(new Request("https://a/api/mcp", { headers: { Authorization: `Bearer ${secret}` } }), secret), true);
  assert.equal(isAuthorized(new Request(`https://a/api/mcp?key=${secret}`), secret), true);
  assert.equal(isAuthorized(new Request("https://a/api/mcp?key=nope"), secret), false);
  assert.equal(isAuthorized(new Request("https://a/api/mcp", { headers: { Authorization: "Bearer short" } }), "short"), false);
});
