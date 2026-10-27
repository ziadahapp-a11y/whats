import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRawKV, redisAuthState, isPaired, clearAuth } from "./wa/auth";
import { toStored, toJid } from "./wa/session";

test("auth state round-trips Buffers through Redis strings", async () => {
  const kv = new MemoryRawKV();
  const a = await redisAuthState(kv);
  assert.equal((await isPaired(kv)).paired, false);
  a.state.creds.registered = true;
  a.state.creds.me = { id: "966500000001:3@s.whatsapp.net", name: "Ali" };
  await a.saveCreds();
  await a.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5]) } } } as any);
  await a.flush();

  const b = await redisAuthState(kv);
  assert.equal(b.state.creds.registered, true);
  assert.ok(Buffer.isBuffer(b.state.creds.noiseKey.private) || b.state.creds.noiseKey.private instanceof Uint8Array);
  const keys = await b.state.keys.get("pre-key", ["1", "2"]);
  assert.deepEqual([...keys["1"].public], [1, 2, 3]);
  assert.equal(keys["2"], undefined);
  assert.deepEqual(await isPaired(kv), { paired: true, me: "966500000001:3@s.whatsapp.net", name: "Ali" });

  await b.state.keys.set({ "pre-key": { "1": null } } as any);
  await b.flush();
  assert.equal((await b.state.keys.get("pre-key", ["1"]))["1"], undefined);

  await clearAuth(kv);
  assert.equal((await isPaired(kv)).paired, false);
});

test("lock is exclusive", async () => {
  const kv = new MemoryRawKV();
  assert.equal(await kv.set("wa:lock", "a", { nx: true, ex: 10 }), "OK");
  assert.equal(await kv.set("wa:lock", "b", { nx: true, ex: 10 }), null);
});

test("message conversion", () => {
  const dm = toStored({ key: { remoteJid: "966500000001@s.whatsapp.net", id: "A1", fromMe: false }, messageTimestamp: 1790000000, pushName: "Sara", message: { conversation: "وينك؟" } } as any)!;
  assert.equal(dm.text, "وينك؟");
  assert.equal(dm.direction, "in");
  assert.equal(dm.sender, "966500000001");
  assert.equal(dm.senderName, "Sara");

  const grp = toStored({ key: { remoteJid: "1203630@g.us", id: "G1", fromMe: false, participant: "99887766@lid", participantAlt: "966500000002@s.whatsapp.net" }, messageTimestamp: 1790000001, message: { ephemeralMessage: { message: { extendedTextMessage: { text: "الاجتماع بكرة", contextInfo: { stanzaId: "A0" } } } } } } as any)!;
  assert.equal(grp.text, "الاجتماع بكرة");
  assert.equal(grp.sender, "966500000002");
  assert.equal(grp.replyTo, "A0");

  const img = toStored({ key: { remoteJid: "966500000001@s.whatsapp.net", id: "I1", fromMe: true }, messageTimestamp: 1790000002, message: { imageMessage: { caption: "شوف", mimetype: "image/jpeg" } } } as any)!;
  assert.equal(img.type, "image");
  assert.equal(img.caption, "شوف");
  assert.equal(img.direction, "out");

  assert.equal(toStored({ key: { remoteJid: "status@broadcast", id: "S" }, message: { conversation: "x" } } as any), null);
  assert.equal(toStored({ key: { remoteJid: "1@s.whatsapp.net", id: "P" }, message: { protocolMessage: {} } } as any), null);
});

test("toJid", () => {
  assert.equal(toJid("+966 50 000 0001"), "966500000001@s.whatsapp.net");
  assert.equal(toJid("1203630@g.us"), "1203630@g.us");
  assert.throws(() => toJid("12"));
});
