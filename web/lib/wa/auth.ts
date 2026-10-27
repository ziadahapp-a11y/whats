// Baileys auth state kept in Redis, so a serverless function can resume the
// linked-device session on every invocation without a disk.

import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from "baileys";

/** Plain string key-value operations (no JSON auto-parsing). */
export interface RawKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys?(pattern: string): Promise<string[]>;
}

export class MemoryRawKV implements RawKV {
  private m = new Map<string, { v: string; exp?: number }>();
  async get(k: string) {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.m.delete(k);
      return null;
    }
    return e.v;
  }
  async set(k: string, v: string, opts?: { ex?: number; nx?: boolean }) {
    if (opts?.nx && (await this.get(k)) !== null) return null;
    this.m.set(k, { v, exp: opts?.ex ? Date.now() + opts.ex * 1000 : undefined });
    return "OK";
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.m.delete(k));
    return keys.length;
  }
  async keys(pattern: string) {
    const prefix = pattern.replace(/\*$/, "");
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
}

const P = "wa:";

export async function redisAuthState(kv: RawKV): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; flush: () => Promise<void> }> {
  const read = async (key: string) => {
    const raw = await kv.get(P + key);
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  };
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  const write = (key: string, value: unknown) => track(kv.set(P + key, JSON.stringify(value, BufferJSON.replacer)));
  const remove = (key: string) => track(kv.del(P + key));

  const creds = (await read("creds")) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`k:${type}:${id}`);
              if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              if (value) out[id] = value;
            }),
          );
          return out;
        },
        set: async (data: any) => {
          const ops: Promise<unknown>[] = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              ops.push(value ? write(`k:${type}:${id}`, value) : remove(`k:${type}:${id}`));
            }
          }
          await Promise.all(ops);
        },
      },
    },
    saveCreds: async () => {
      await write("creds", creds);
    },
    /** Waits for every in-flight write, so nothing is lost when the function ends. */
    flush: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

/** Forgets the linked device (after logout or to re-pair). */
export async function clearAuth(kv: RawKV) {
  const keys = kv.keys ? await kv.keys(P + "*") : [P + "creds"];
  for (let i = 0; i < keys.length; i += 500) await kv.del(...keys.slice(i, i + 500));
}

export async function isPaired(kv: RawKV): Promise<{ paired: boolean; me?: string; name?: string }> {
  const raw = await kv.get(P + "creds");
  if (!raw) return { paired: false };
  const c = JSON.parse(raw, BufferJSON.reviver);
  return { paired: !!c.registered || !!c.me?.id, me: c.me?.id, name: c.me?.name };
}
