// Several WhatsApp numbers on one deployment.
//
// Each number is an "account". The first one is `main` and keeps the exact keys
// the single-number version used, so an existing link keeps working. Every
// other account gets its own prefix for the Baileys session, the lock, the
// message cache and the flow state, so nothing can mix between numbers.

import { randomBytes } from "node:crypto";
import { clearAuth, isPaired, type RawKV } from "./auth";

export const MAIN = "main";
export const OFFICIAL = "official";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
const REGISTRY = "meta:accounts";

export type Account = { id: string; label: string; createdAt?: number };

export const isAccountId = (id: string) => ID_RE.test(id);

/** Prefix for the session, lock and flow state kept as raw strings. */
export const rawPrefix = (id: string) => (id === MAIN ? "" : `acct:${id}:`);
/** Prefix for the message cache (the JSON store). */
export const cachePrefix = (id: string) => (id === MAIN ? "p:" : `pa:${id}:`);

/** A view of `raw` where every key is stored under `prefix`. */
export function scopeRaw(raw: RawKV, prefix: string): RawKV {
  if (!prefix) return raw;
  return {
    get: (k) => raw.get(prefix + k),
    set: (k, v, o) => raw.set(prefix + k, v, o),
    del: (...ks) => raw.del(...ks.map((k) => prefix + k)),
    keys: raw.keys ? async (p) => (await raw.keys!(prefix + p)).map((k) => k.slice(prefix.length)) : undefined,
  };
}

function parse(v: string | null): Account[] {
  if (!v) return [];
  try {
    const rows = JSON.parse(v);
    return Array.isArray(rows) ? rows.filter((a) => a && typeof a.id === "string" && typeof a.label === "string") : [];
  } catch {
    return [];
  }
}

export async function listAccounts(base: RawKV): Promise<Account[]> {
  const rows = parse(await base.get(REGISTRY));
  const main = rows.find((a) => a.id === MAIN) ?? { id: MAIN, label: "الرقم الرئيسي" };
  return [main, ...rows.filter((a) => a.id !== MAIN)];
}

async function save(base: RawKV, rows: Account[]) {
  await base.set(REGISTRY, JSON.stringify(rows));
}

export async function addAccount(base: RawKV, label: string): Promise<Account> {
  const clean = label.trim().slice(0, 40);
  if (!clean) throw new Error("Give the number a name, e.g. Work or Personal 2.");
  const rows = parse(await base.get(REGISTRY));
  if (rows.filter((a) => a.id !== MAIN).length >= 9) throw new Error("At most 10 numbers per deployment.");
  const taken = new Set([MAIN, OFFICIAL, ...rows.map((a) => a.id)]);
  let id = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 14);
  if (!id) id = "n" + randomBytes(3).toString("hex");
  while (taken.has(id)) id = `${id.slice(0, 14)}-${randomBytes(2).toString("hex")}`;
  const account = { id, label: clean, createdAt: Date.now() };
  await save(base, [...rows, account]);
  return account;
}

export async function renameAccount(base: RawKV, id: string, label: string) {
  const clean = label.trim().slice(0, 40);
  if (!clean) throw new Error("The name cannot be empty.");
  const rows = parse(await base.get(REGISTRY));
  const i = rows.findIndex((a) => a.id === id);
  if (i >= 0) rows[i] = { ...rows[i], label: clean };
  else if (id === MAIN) rows.push({ id: MAIN, label: clean });
  else throw new Error("Unknown account.");
  await save(base, rows);
}

/** Unlinks and forgets one account's keys and cache. `main` stays in the list but is emptied. */
export async function removeAccount(base: RawKV, id: string) {
  const scoped = scopeRaw(base, rawPrefix(id));
  await clearAuth(scoped);
  if (id === MAIN) return;
  const rows = parse(await base.get(REGISTRY));
  await save(base, rows.filter((a) => a.id !== id));
  if (base.keys) {
    for (const pattern of [`acct:${id}:*`, `${cachePrefix(id)}*`]) {
      const keys = await base.keys(pattern);
      for (let i = 0; i < keys.length; i += 500) await base.del(...keys.slice(i, i + 500));
    }
  }
}

export async function accountStatus(base: RawKV, id: string) {
  return isPaired(scopeRaw(base, rawPrefix(id)));
}
