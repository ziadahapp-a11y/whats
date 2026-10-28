// End-to-end check against a production build: webhook verification and
// signed delivery, MCP auth, tools/list and reading what the webhook stored.
// Uses the in-memory store and never calls Meta.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const PORT = 3123;
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  PORT: String(PORT),
  MCP_SECRET: "e2e-secret-0123456789abcdef",
  META_APP_SECRET: "app-secret",
  WEBHOOK_VERIFY_TOKEN: "verify-me",
  WHATSAPP_PHONE_NUMBER_ID: "PN1",
  ALLOW_MEMORY_STORE: "1",
  KV_REST_API_URL: "",
  UPSTASH_REDIS_REST_URL: "",
};
const srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "ignore", "inherit"] });
const stop = () => srv.kill("SIGTERM");

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

async function mcp(method, params, auth = true, path = "/api/mcp") {
  console.log("mcp", path, method);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(auth ? { Authorization: `Bearer ${env.MCP_SECRET}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  const data = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(raw.split("\n").find((l) => l.startsWith("data: ")).slice(6));
  return { status: res.status, data };
}

try {
  await waitUp();

  // Landing + setup render.
  assert.equal((await fetch(base)).status, 200);
  const setup = await (await fetch(`${base}/setup`)).text();
  assert.ok(setup.includes("/api/webhook"));
  assert.ok(!setup.includes(env.MCP_SECRET), "setup page must not leak the secret");

  // Webhook verification handshake.
  let r = await fetch(`${base}/api/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242`);
  assert.equal(await r.text(), "4242");
  r = await fetch(`${base}/api/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(r.status, 403);

  // Signed delivery.
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, contacts: [{ wa_id: "966500000009", profile: { name: "Noura" } }], messages: [{ from: "966500000009", id: "wamid.e2e", timestamp: String(ts), type: "text", text: { body: "Is the shop open on Friday?" } }] } }] }],
  });
  r = await fetch(`${base}/api/webhook`, { method: "POST", body, headers: { "X-Hub-Signature-256": "sha256=" + createHmac("sha256", env.META_APP_SECRET).update(body).digest("hex") } });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/webhook`, { method: "POST", body, headers: { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) } });
  assert.equal(r.status, 401);

  // MCP auth.
  assert.equal((await mcp("tools/list", {}, false)).status, 401);

  // MCP tools.
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const tools = (await mcp("tools/list", {})).data.result.tools.map((t) => t.name).sort();
  console.log("tools:", tools.join(", "));
  assert.equal(tools.length, 24);
  for (const t of ["create_template", "campaign_dry_run", "campaign_start", "campaign_advance", "campaign_control", "campaign_report", "manage_opt_out", "list_opt_outs"]) assert.ok(tools.includes(t), t);

  const convs = await mcp("tools/call", { name: "list_conversations", arguments: {} });
  const convText = convs.data.result.content[0].text;
  assert.ok(convText.includes("Noura"), convText);
  assert.ok(convText.includes('"windowOpen": true'), convText);

  const msgs = await mcp("tools/call", { name: "list_messages", arguments: { contact: "+966 50 000 0009" } });
  const msgText = msgs.data.result.content[0].text;
  assert.ok(msgText.includes("Is the shop open on Friday?"), msgText);
  console.log(msgText);

  const search = await mcp("tools/call", { name: "search_messages", arguments: { query: "friday" } });
  assert.ok(search.data.result.content[0].text.includes("wamid.e2e"));

  // Marketing: a customer's "stop" through the signed webhook opts them out; a campaign cannot pass its checks without Meta.
  const call = async (name, args) => (await mcp("tools/call", { name, arguments: args })).data.result;
  assert.equal((await call("list_opt_outs", {})).content[0].text.includes('"total": 0'), true);
  const stopBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from: "966500000009", id: "wamid.e2e.stop", timestamp: String(ts + 5), type: "text", text: { body: "إيقاف" } }] } }] }],
  });
  r = await fetch(`${base}/api/webhook`, { method: "POST", body: stopBody, headers: { "X-Hub-Signature-256": "sha256=" + createHmac("sha256", env.META_APP_SECRET).update(stopBody).digest("hex") } });
  assert.equal(r.status, 200);
  const outs = JSON.parse((await call("list_opt_outs", {})).content[0].text);
  assert.equal(outs.total, 1);
  assert.equal(outs.optOuts[0].phone, "96650****009");
  assert.ok(!JSON.stringify(outs).includes("966500000009"), "numbers are masked");

  const dry = await call("campaign_dry_run", { template_name: "summer_offer", language: "ar", rows: [{ phone: "0500000001", consent_date: "2026-09-01", params: ["أحمد"] }] });
  const dryOut = JSON.parse(dry.content[0].text);
  assert.equal(dryOut.ok, false, "without Meta the number and template cannot be verified");
  assert.equal(dryOut.campaignId, undefined);
  assert.equal((await call("campaign_dry_run", { template_name: "x" })).isError, true, "needs an upload or rows");
  const badStart = await call("campaign_start", { campaign_id: "nope", confirm_token: "nope" });
  assert.equal(badStart.isError, true);
  const tpl = await call("create_template", { name: "x", body: "{{1}} hello", body_examples: ["a"] });
  assert.equal(tpl.isError, true, "a draft with errors is refused before anything is sent");

  // The dashboard's campaigns API: master key only, uploads parse, nothing starts without a dry run.
  const camp = (init = {}) => fetch(`${base}/api/personal/campaigns`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${env.MCP_SECRET}` } });
  assert.equal((await fetch(`${base}/api/personal/campaigns`)).status, 401);
  const form = new FormData();
  form.append("file", new Blob(["phone,consent_date,var1\n0500000001,2026-09-01,أحمد\n12345,2026-09-01,x\n"]), "list.csv");
  const up = await (await camp({ method: "POST", body: form })).json();
  assert.equal(up.rows, 2);
  assert.equal(up.paramCount, 1);
  assert.ok(!JSON.stringify(up).includes("0500000001"), "the upload summary masks numbers");
  const json = (op) => camp({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
  assert.equal((await json({ op: "dry_run", uploadId: "gone", template: "t", language: "ar" })).status, 404);
  assert.equal((await json({ op: "start", id: "nope", token: "nope" })).status, 409);
  const tplCheck = await (await json({ op: "template", draft: { name: "x", language: "ar", body: "{{1}} hello", bodyExamples: ["a"] }, submit: true })).json();
  assert.equal(tplCheck.ok, false, "a draft with errors is not submitted");
  assert.equal((await json({ op: "nonsense" })).status, 400);
  assert.equal((await (await camp()).json()).campaigns.length, 0);

  // Personal mode (linked device): wiring, auth and Baileys loading, without a phone.
  r = await fetch(`${base}/api/personal/status`);
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/personal/status`, { headers: { Authorization: `Bearer ${env.MCP_SECRET}` } });
  assert.equal((await r.json()).accounts[0].paired, false);
  assert.equal((await mcp("tools/list", {}, false, "/api/personal/mcp")).status, 401);
  const ptools = (await mcp("tools/list", {}, true, "/api/personal/mcp")).data.result.tools.map((t) => t.name);
  console.log("personal tools:", ptools.join(", "));
  assert.equal(ptools.length, 12);
  const st = await mcp("tools/call", { name: "get_status", arguments: {} }, true, "/api/personal/mcp");
  assert.ok(st.data.result.content[0].text.includes('"paired": false'));
  const sy = await mcp("tools/call", { name: "sync", arguments: {} }, true, "/api/personal/mcp");
  assert.equal(sy.data.result.isError, true);
  assert.ok(sy.data.result.content[0].text.includes("not linked"), sy.data.result.content[0].text);
  assert.equal((await fetch(`${base}/personal`)).status, 200);
  assert.equal((await fetch(`${base}/api/cron/sync`)).status, 401);

  console.log("e2e: all checks passed");
  stop();
} catch (e) {
  stop();
  console.error(e);
  process.exit(1);
}
