import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store, type StoredMessage } from "./store";

const msg = (id: string, waId: string, timestamp: number, direction: "in" | "out"): StoredMessage =>
  ({ id, waId, timestamp, direction, type: "text", text: id } as unknown as StoredMessage);

test("summary chat list matches the legacy list, and the window follows the last inbound message", async () => {
  const kv = new MemoryKV();
  const store = new Store(kv);
  const now = 1_700_000_000;
  await store.saveMessage(msg("a1", "111", now - 100, "in"));
  await store.saveMessage(msg("a2", "111", now - 50, "out"));
  await store.saveMessage(msg("b1", "222", now - 200, "in"));
  await store.setName("222", "Sara");

  const legacy = await store.conversations(10, undefined, now);
  assert.equal(await store.rebuildSummary(), 2);
  const fast = await store.conversations(10, undefined, now);

  assert.deepEqual(fast.map((c) => c.waId), legacy.map((c) => c.waId));
  assert.deepEqual(fast.map((c) => c.name), legacy.map((c) => c.name));
  assert.deepEqual(fast.map((c) => c.windowOpen), legacy.map((c) => c.windowOpen));
  assert.equal(fast[0].waId, "111");
  assert.equal(fast[1].name, "Sara");
});

test("a new chat after the build is in the summary, and names are kept", async () => {
  const kv = new MemoryKV();
  const store = new Store(kv);
  const now = 1_700_000_000;
  await store.saveMessage(msg("a1", "111", now - 100, "in"));
  await store.rebuildSummary();
  await store.setName("333", "New");
  await store.saveMessage(msg("c1", "333", now - 10, "in"));
  const list = await store.conversations(10, undefined, now);
  assert.equal(list[0].waId, "333");
  assert.equal(list[0].name, "New");
});
