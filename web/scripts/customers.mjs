#!/usr/bin/env node
// Shows every customer project connected to the main repo and whether it runs the latest main.
//
//   VERCEL_TOKEN=... node scripts/customers.mjs [--team team_xxx] [--deploy]      list (and --deploy = redeploy the ones behind)
//   VERCEL_TOKEN=... node scripts/customers.mjs --relink PROJECT [--team ...]     point a project (e.g. made from a clone) at the main repo
//
// It reads each project's production deployment and public /api/version only. It never reads env values or messages.

const REPO = process.env.REPO || "aliaaldihnayn-lab/whats-mcp";
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const team = arg("team", process.env.VERCEL_TEAM_ID);
const token = process.env.VERCEL_TOKEN;
if (!token) {
  console.error("Set VERCEL_TOKEN (Vercel dashboard > Settings > Tokens).");
  process.exit(1);
}

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

const relink = arg("relink");
if (relink) {
  const p = await api("GET", `/v9/projects/${encodeURIComponent(relink)}`);
  if (p.link) await api("DELETE", `/v9/projects/${p.id}/link`);
  await api("POST", `/v9/projects/${p.id}/link`, { type: "github", repo: REPO });
  console.log(`${p.name} is now connected to ${REPO}. Next pushes to main deploy it. Check Root Directory = web in its Settings > General.`);
  process.exit(0);
}

const gh = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers: { Accept: "application/vnd.github+json" } });
const head = gh.ok ? (await gh.json()).sha : null;
console.log(`main: ${head ? head.slice(0, 7) : "unknown (GitHub API refused)"}\n`);

const { projects } = await api("GET", "/v9/projects?limit=100");
let behind = 0;
for (const p of projects) {
  const mine = p.link?.type === "github" && `${p.link.org}/${p.link.repo}`.toLowerCase() === REPO.toLowerCase();
  const dep = (await api("GET", `/v6/deployments?projectId=${p.id}&target=production&limit=1`)).deployments?.[0];
  const sha = dep?.meta?.githubCommitSha ?? null;
  const domain = p.alias?.[0]?.domain ?? `${p.name}.vercel.app`;
  let live = "-";
  try {
    const r = await fetch(`https://${domain}/api/version`, { signal: AbortSignal.timeout(8000) });
    live = r.ok ? ((await r.json()).commit ?? "?") : `HTTP ${r.status}`;
  } catch {
    live = "unreachable";
  }
  if (!mine && !p.name.includes("whats")) continue;
  const state = !mine ? "NOT CONNECTED to main repo" : head && sha && sha !== head ? "BEHIND" : "up to date";
  if (state !== "up to date") behind++;
  console.log(`${p.name.padEnd(28)} ${state.padEnd(28)} deployed ${sha?.slice(0, 7) ?? "-"}  live ${live}  https://${domain}`);
  if (process.argv.includes("--deploy") && state === "BEHIND" && dep) {
    await api("POST", "/v13/deployments?forceNew=1", { name: p.name, project: p.id, target: "production", gitSource: { type: "github", ref: "main", repoId: p.link.repoId } });
    console.log("  -> redeploy started");
  }
}
console.log(behind ? `\n${behind} project(s) need attention. Fix with --relink PROJECT or --deploy.` : "\nAll good.");
