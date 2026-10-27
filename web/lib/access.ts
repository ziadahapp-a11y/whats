// Who may call the MCP endpoints and the dashboard.
//
//  - MCP_SECRET        the master key: dashboard, key management, everything.
//  - MCP_SECRETS       optional extra full-access keys (comma separated) for quick multi-device use.
//  - device keys       created in the dashboard, one per device or person, each limited to
//                      chosen numbers and to read-only or read-and-send. Only a SHA-256
//                      hash is stored, so a leaked database does not leak working keys.
//
// A key travels as `Authorization: Bearer <key>` or as `?key=<key>` in the URL.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RawKV } from "./wa/auth";

export type Scope = "read" | "full";
export type Principal = {
  kind: "master" | "extra" | "device";
  id: string;
  label?: string;
  /** "*" = every number. */
  accounts: string[] | "*";
  scope: Scope;
};

export type DeviceKey = { id: string; label: string; accounts: string[] | "*"; scope: Scope; createdAt: number; lastUsed?: number };

const KEY_PREFIX = "meta:key:";
export const TOKEN_PREFIX = "wmk_";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function extractToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return bearer || (new URL(req.url).searchParams.get("key") ?? "").trim();
}

export async function authenticate(req: Request, cfg: { mcpSecret: string }, base: RawKV, env: Record<string, string | undefined> = process.env): Promise<Principal | null> {
  const token = extractToken(req);
  if (!token) return null;
  if (cfg.mcpSecret.length >= 24 && safeEqual(token, cfg.mcpSecret)) return { kind: "master", id: "master", accounts: "*", scope: "full" };
  for (const extra of (env.MCP_SECRETS ?? "").split(",").map((s) => s.trim())) {
    if (extra.length >= 24 && safeEqual(token, extra)) return { kind: "extra", id: sha(extra).slice(0, 8), accounts: "*", scope: "full" };
  }
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const rec = await readKey(base, KEY_PREFIX + sha(token));
    if (!rec) return null;
    // Remember when it was last used, at most every ten minutes.
    if (!rec.lastUsed || Date.now() - rec.lastUsed > 600_000) await base.set(KEY_PREFIX + sha(token), JSON.stringify({ ...rec, lastUsed: Date.now() }));
    return { kind: "device", id: rec.id, label: rec.label, accounts: rec.accounts, scope: rec.scope };
  } catch {
    return null;
  }
}

async function readKey(base: RawKV, key: string): Promise<DeviceKey | null> {
  const raw = await base.get(key);
  if (!raw) return null;
  try {
    const k = JSON.parse(raw);
    return k && typeof k.id === "string" ? (k as DeviceKey) : null;
  } catch {
    return null;
  }
}

export function canUse(p: Principal, account: string): boolean {
  return p.accounts === "*" || p.accounts.includes(account);
}

export async function createDeviceKey(base: RawKV, input: { label: string; accounts: string[] | "*"; scope: Scope }): Promise<{ token: string; key: DeviceKey }> {
  const label = input.label.trim().slice(0, 40);
  if (!label) throw new Error("Give the key a name, e.g. Laptop or Ahmed's phone.");
  if (input.accounts !== "*" && !input.accounts.length) throw new Error("Choose at least one number.");
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const key: DeviceKey = { id: sha(token).slice(0, 10), label, accounts: input.accounts, scope: input.scope, createdAt: Date.now() };
  await base.set(KEY_PREFIX + sha(token), JSON.stringify(key));
  return { token, key };
}

export async function listDeviceKeys(base: RawKV): Promise<DeviceKey[]> {
  const names = base.keys ? await base.keys(KEY_PREFIX + "*") : [];
  const rows = await Promise.all(names.map((n) => readKey(base, n)));
  return rows.filter((k): k is DeviceKey => !!k).sort((a, b) => a.createdAt - b.createdAt);
}

export async function revokeDeviceKey(base: RawKV, id: string): Promise<boolean> {
  const names = base.keys ? await base.keys(KEY_PREFIX + "*") : [];
  for (const n of names) {
    const k = await readKey(base, n);
    if (k?.id === id) {
      await base.del(n);
      return true;
    }
  }
  return false;
}
