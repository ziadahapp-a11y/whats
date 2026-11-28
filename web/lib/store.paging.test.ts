import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store, type StoredMessage } from "./store";

const CHAT = "966500000001@s.whatsapp.net";
const BASE = 1_790_000_000;

function msg(i: number): StoredMessage {
  return { id: `m${i}`, waId: CHAT, direction: "in", type: "text", text: `رسالة ${i}`, timestamp: BASE + i };
}

test("older pages walk back through a long chat without repeats or gaps", async () => {
  const store = new Store(new MemoryKV(), "p:");
  for (let i = 1; i <= 150; i++) await store.saveMessage(msg(i));

  const newest = await store.messages(CHAT, 60);
  assert.equal(newest.length, 60);
  assert.equal(newest.at(-1)?.id, "m150", "the newest page ends with the newest message");

  const older = await store.messages(CHAT, 60, newest[0]!.timestamp);
  assert.equal(older.length, 60);
  assert.equal(older.at(-1)?.id, "m90", "the next page ends just before the first one");

  const oldest = await store.messages(CHAT, 60, older[0]!.timestamp);
  assert.equal(oldest.length, 30, "the rest of the chat");
  assert.equal(oldest[0]?.id, "m1");
  assert.equal(oldest.at(-1)?.id, "m30");

  const none = await store.messages(CHAT, 60, oldest[0]!.timestamp);
  assert.equal(none.length, 0);
});
