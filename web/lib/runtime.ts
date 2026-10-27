// Wires config, Redis and the API clients together for the route handlers.

import { Redis } from "@upstash/redis";
import { readConfig, type Config } from "./config";
import { Graph } from "./graph";
import { MemoryKV, Store, type KV } from "./store";
import { MemoryRawKV, type RawKV } from "./wa/auth";
import { cachePrefix, rawPrefix, scopeRaw } from "./wa/accounts";

// Route handlers are bundled separately, so share the dev stores via globalThis.
const g = globalThis as typeof globalThis & { __whatsMcpMemory?: MemoryKV; __whatsMcpRaw?: MemoryRawKV };

function redis(cfg: Config, raw = false) {
  return new Redis({ url: cfg.redisUrl, token: cfg.redisToken, automaticDeserialization: !raw });
}

export function storeFor(cfg: Config, prefix = ""): Store {
  if (cfg.redisUrl && cfg.redisToken) return new Store(redis(cfg) as unknown as KV, prefix);
  // Local development only: data lives as long as the process does.
  g.__whatsMcpMemory ??= new MemoryKV();
  return new Store(g.__whatsMcpMemory, prefix);
}

export function rawFor(cfg: Config): RawKV {
  if (cfg.redisUrl && cfg.redisToken) return redis(cfg, true) as unknown as RawKV;
  g.__whatsMcpRaw ??= new MemoryRawKV();
  return g.__whatsMcpRaw;
}

/** Official mode (Cloud API). */
export function runtime() {
  const cfg = readConfig();
  return { cfg, store: storeFor(cfg), graph: new Graph(cfg) };
}

/** Everything one WhatsApp number needs: its session/state keys and its message cache. */
export type AccountDeps = { id: string; raw: RawKV; store: Store };

/** Personal mode (linked devices, connect on demand). `main` is the first number. */
export function personal() {
  const cfg = readConfig();
  const base = rawFor(cfg);
  const account = (id: string): AccountDeps => ({ id, raw: scopeRaw(base, rawPrefix(id)), store: storeFor(cfg, cachePrefix(id)) });
  return { cfg, base, account, store: storeFor(cfg, "p:"), raw: base };
}
