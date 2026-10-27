#!/usr/bin/env node
// Creates one Vercel project per customer from this repo, with its own secrets, AI settings and
// deployment protection off, then deploys it.
//
//   VERCEL_TOKEN=... node scripts/new-customer.mjs --name acme [--team team_xxx] [--ai deepseek|claude|none]
//                    [--redis-url https://... --redis-token ...] [--dry-run]
//
// Secrets never go on the command line: the customer's AI key comes from CUSTOMER_AI_KEY, and the
// Redis token from --redis-token only if you accept it in your shell history (or use REDIS_TOKEN).
// MCP_SECRET and CRON_SECRET are generated here and printed ONCE at the end. Give them to the customer.

import { randomBytes } from "node:crypto";

const REPO = process.env.REPO || "aliaaldihnayn-lab/whats-mcp";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const name = (arg("name") || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
const team = arg("team", process.env.VERCEL_TEAM_ID);
const ai = arg("ai", "none");
const redisUrl = arg("redis-url");
const redisToken = process.env.REDIS_TOKEN || arg("redis-token");
const dry = flag("dry-run");
const token = process.env.VERCEL_TOKEN;

function fail(m) {
  console.error("Error: " + m);
  process.exit(1);
}
if (!name || name.length > 40) fail("--name is required (letters, numbers, dashes; max 40).");
if (!["none", "deepseek", "claude"].includes(ai)) fail("--ai must be none, deepseek or claude.");
if (!dry && !token) fail("Set VERCEL_TOKEN (Vercel dashboard > Settings > Tokens).");
if (ai !== "none" && !process.env.CUSTOMER_AI_KEY) fail("Set CUSTOMER_AI_KEY to the customer's AI key (env var, not an argument).");
if ((redisUrl && !redisToken) || (!redisUrl && redisToken)) fail("Give both --redis-url and the token (REDIS_TOKEN).");

const mcp = randomBytes(24).toString("hex");
const cron = randomBytes(24).toString("hex");
const env = [
  ["MCP_SECRET", mcp],
  ["CRON_SECRET", cron],
  ["AI_MAX_PER_DAY", "300"],
];
if (ai === "claude") env.push(["ANTHROPIC_API_KEY", process.env.CUSTOMER_AI_KEY]);
if (ai === "deepseek") env.push(["AI_COMPAT_URL", "https://api.deepseek.com"], ["AI_COMPAT_KEY", process.env.CUSTOMER_AI_KEY], ["AI_COMPAT_MODEL", process.env.AI_COMPAT_MODEL || "deepseek-flash"]);
if (redisUrl) env.push(["KV_REST_API_URL", redisUrl], ["KV_REST_API_TOKEN", redisToken]);

async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.vercel.com${path}${team ? `${sep}teamId=${encodeURIComponent(team)}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error?.message ?? ""}`);
  return data;
}

if (dry) {
  console.log(`[dry run] would create project "${name}" from ${REPO} (root: web)${team ? ` in team ${team}` : ""}`);
  console.log("[dry run] env:", env.map(([k]) => k).join(", "));
  console.log("[dry run] would turn off Vercel Authentication, deploy main to production" + (redisUrl ? "" : ", and remind you to connect Redis"));
  process.exit(0);
}

try {
  const project = await api("POST", "/v11/projects", {
    name,
    framework: "nextjs",
    rootDirectory: "web",
    gitRepository: { type: "github", repo: REPO },
    environmentVariables: env.map(([key, value]) => ({ key, value, type: "sensitive", target: ["production"] })),
  });
  console.log(`Project created: ${project.name}`);

  await api("PATCH", `/v9/projects/${project.id}`, { ssoProtection: null });
  console.log("Deployment protection: off");

  const dep = await api("POST", "/v13/deployments?forceNew=1", {
    name: project.name,
    project: project.id,
    target: "production",
    gitSource: { type: "github", ref: "main", repoId: project.link?.repoId },
  });
  console.log(`Deploying: https://${dep.url}`);

  console.log("\n=== Give these to the customer. They are shown only once. ===");
  console.log(`System:      https://${project.name}.vercel.app/personal`);
  console.log(`MCP_SECRET:  ${mcp}`);
  console.log(`CRON_SECRET: ${cron}`);
  if (!redisUrl) {
    console.log(`\nNEXT STEP: connect a Redis database: Vercel > ${project.name} > Storage > Create > Upstash Redis > Connect, then Redeploy.`);
    console.log("Do not share one Redis between customers.");
  }
  console.log("Then: open /personal, link the number, press 'Test AI', create a device key.");
} catch (e) {
  fail(e.message + "\n(If the project was created, finish or delete it in the Vercel dashboard before running again.)");
}
