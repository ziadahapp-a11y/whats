import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRawKV } from "./wa/auth";
import { addAccount, listAccounts, removeAccount, scopeRaw, rawPrefix, cachePrefix, MAIN } from "./wa/accounts";
import { authenticate, canUse, createDeviceKey, listDeviceKeys, revokeDeviceKey } from "./access";

const MASTER = "master-secret-0123456789abcdef";
const req = (key?: string, bearer?: string) => new Request(`https://x.test/api/personal/mcp${key ? `?key=${key}` : ""}`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });

test("accounts: main is implicit, others are isolated by prefix", async () => {
  const base = new MemoryRawKV();
  assert.deepEqual((await listAccounts(base)).map((a) => a.id), [MAIN]);
  const work = await addAccount(base, "Work");
  const second = await addAccount(base, "Work");
  assert.equal(work.id, "work");
  assert.notEqual(second.id, work.id);
  const arabic = await addAccount(base, "رقم الشغل");
  assert.match(arabic.id, /^n[0-9a-f]{6}$/);
  assert.equal((await listAccounts(base)).length, 4);

  const a = scopeRaw(base, rawPrefix(MAIN));
  const w = scopeRaw(base, rawPrefix("work"));
  await a.set("wa:creds", "A");
  await w.set("wa:creds", "W");
  assert.equal(await a.get("wa:creds"), "A");
  assert.equal(await w.get("wa:creds"), "W");
  assert.equal(await base.get("wa:creds"), "A", "main keeps the legacy key names");
  assert.equal(await base.get("acct:work:wa:creds"), "W");
  assert.deepEqual(await w.keys!("wa:*"), ["wa:creds"]);
  assert.notEqual(cachePrefix(MAIN), cachePrefix("work"));

  await removeAccount(base, "work");
  assert.equal(await base.get("acct:work:wa:creds"), null);
  assert.equal((await listAccounts(base)).some((x) => x.id === "work"), false);
});

test("master, extra and device keys", async () => {
  const base = new MemoryRawKV();
  const cfg = { mcpSecret: MASTER };
  const env = { MCP_SECRETS: "extra-secret-0123456789abcdefgh, short" };

  assert.equal((await authenticate(req(), cfg, base, env)), null);
  assert.equal((await authenticate(req("wrong"), cfg, base, env)), null);
  assert.equal((await authenticate(req(MASTER), cfg, base, env))?.kind, "master");
  assert.equal((await authenticate(req(undefined, MASTER), cfg, base, env))?.kind, "master");
  assert.equal((await authenticate(req("extra-secret-0123456789abcdefgh"), cfg, base, env))?.kind, "extra");
  assert.equal(await authenticate(req("short"), cfg, base, env), null, "too-short extra secrets are ignored");
  assert.equal(await authenticate(req(MASTER), { mcpSecret: "tiny" }, base, {}), null, "a short master secret never authenticates");

  const { token, key } = await createDeviceKey(base, { label: "Laptop", accounts: ["work"], scope: "read" });
  assert.match(token, /^wmk_[0-9a-f]{48}$/);
  const p = await authenticate(req(token), cfg, base, env);
  assert.equal(p?.kind, "device");
  assert.equal(p?.scope, "read");
  assert.equal(canUse(p!, "work"), true);
  assert.equal(canUse(p!, "main"), false);

  // Only a hash is stored: the token itself is nowhere in the database.
  for (const k of (await base.keys!("*"))) assert.ok(!(await base.get(k))!.includes(token) && !k.includes(token));
  assert.equal((await listDeviceKeys(base)).length, 1);
  assert.equal((await listDeviceKeys(base))[0].id, key.id);

  const all = await createDeviceKey(base, { label: "Phone", accounts: "*", scope: "full" });
  assert.equal(canUse((await authenticate(req(undefined, all.token), cfg, base, env))!, "anything"), true);

  assert.equal(await revokeDeviceKey(base, key.id), true);
  assert.equal(await authenticate(req(token), cfg, base, env), null, "revoked keys stop working at once");
  assert.equal(await revokeDeviceKey(base, key.id), false);
  await assert.rejects(createDeviceKey(base, { label: " ", accounts: "*", scope: "full" }), /name/);
  await assert.rejects(createDeviceKey(base, { label: "x", accounts: [], scope: "full" }), /at least one/i);
});
