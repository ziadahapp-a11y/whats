// Remote MCP servers ("connectors") Claude may use when it carries out a task from WhatsApp:
// a store, a design tool, a social scheduler... Kept once per deployment in Redis.
// Claude's API calls them directly, so they must be public https addresses.

import type { RawKV } from "./wa/auth";

export type Connector = { name: string; url: string; token?: string };
const KEY = "meta:connectors";
const NAME = /^[a-zA-Z0-9_-]{1,30}$/;

export async function listConnectors(base: RawKV): Promise<Connector[]> {
  try {
    const rows = JSON.parse((await base.get(KEY)) ?? "[]");
    return Array.isArray(rows) ? rows.filter((c) => c && NAME.test(c.name) && typeof c.url === "string") : [];
  } catch {
    return [];
  }
}

export async function saveConnector(base: RawKV, c: Connector): Promise<void> {
  if (!NAME.test(c.name)) throw new Error("Name: letters, numbers, - or _ (max 30).");
  let u: URL;
  try {
    u = new URL(c.url);
  } catch {
    throw new Error("The address is not a valid link.");
  }
  if (u.protocol !== "https:") throw new Error("The connector address must start with https://");
  const rows = await listConnectors(base);
  if (!rows.some((r) => r.name === c.name) && rows.length >= 10) throw new Error("At most 10 connectors.");
  const old = rows.find((r) => r.name === c.name);
  const next = { name: c.name, url: u.toString(), token: c.token?.trim() || old?.token };
  await base.set(KEY, JSON.stringify([...rows.filter((r) => r.name !== c.name), next]));
}

export async function removeConnector(base: RawKV, name: string): Promise<void> {
  await base.set(KEY, JSON.stringify((await listConnectors(base)).filter((c) => c.name !== name)));
}

/** Never send tokens to the browser. */
export const publicView = (c: Connector) => ({ name: c.name, url: c.url, hasToken: !!c.token });
