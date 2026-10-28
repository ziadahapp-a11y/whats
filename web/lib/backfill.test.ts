import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKV, Store } from "./store";

const msg = (id: string, ts: number, waId = "a@s.whatsapp.net") => ({ id, waId, direction: "in" as const, type: "text", text: id, timestamp: ts });

test("older messages do not push a chat down the list, and oldest() finds the anchor", async () => {
  const s = new Store(new MemoryKV());
  await s.saveMessage(msg("n1", 2000, "new@s.whatsapp.net"));
  await s.saveMessage(msg("o1", 1000, "old@s.whatsapp.net"));
  await s.saveMessage(msg("o0", 10, "new@s.whatsapp.net")); // backfilled, far older
  assert.deepEqual(await s.allChats(), ["new@s.whatsapp.net", "old@s.whatsapp.net"]);
  assert.equal((await s.oldest("new@s.whatsapp.net"))?.id, "o0");
  assert.equal(await s.oldest("none@s.whatsapp.net"), null);
});

test("more than 2000 messages per chat are kept", async () => {
  const s = new Store(new MemoryKV());
  for (let i = 0; i < 2100; i++) await s.saveMessage(msg(`m${i}`, 1000 + i));
  assert.equal((await s.oldest("a@s.whatsapp.net"))?.id, "m0");
});
