"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const KEY = "whats-mcp-secret";

export function readSecret() {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export async function call<T = any>(secret: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${secret}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Status = {
  accounts: { id: string; label: string; paired: boolean; me?: string; name?: string; lastSync: number | null; cachedChats: number }[];
  storage: boolean;
  ai: boolean;
  cron: boolean;
  official: boolean;
  flowsPaused: boolean;
};

type Session = { secret: string; status: Status; reload: () => Promise<void> };
const SessionCtx = createContext<Session | null>(null);

/** The secret and server status, loaded once by the /personal layout and shared with every page. */
export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error("useSession must be used under SecretGate");
  return s;
}

/** Asks for MCP_SECRET once per tab, checks it against the server, then renders the page. */
export function SecretGate({ children }: { children: ReactNode | ((secret: string, status: Status, reload: () => Promise<void>) => ReactNode) }) {
  const [secret, setSecret] = useState("");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (s: string) => {
    setBusy(true);
    setError("");
    try {
      const st = await call<Status>(s, "/api/personal/status");
      setStatus(st);
      setSecret(s);
      try {
        sessionStorage.setItem(KEY, s);
      } catch {}
    } catch (e) {
      setStatus(null);
      setSecret("");
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const s = readSecret();
    if (s) {
      setInput(s);
      void load(s);
    }
  }, [load]);

  if (status && secret) {
    const reload = () => load(secret);
    return <SessionCtx.Provider value={{ secret, status, reload }}>{typeof children === "function" ? children(secret, status, reload) : children}</SessionCtx.Provider>;
  }
  return (
    <form
      className="field panel"
      onSubmit={(e) => {
        e.preventDefault();
        void load(input.trim());
      }}
    >
      <label htmlFor="secret">كلمة السر (MCP_SECRET)</label>
      <div className="row">
        <input id="secret" type="password" dir="ltr" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} required minLength={24} />
        <button className="btn solid" type="submit" disabled={busy}>
          {busy ? "…" : "افتح"}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
    </form>
  );
}

// Stale-while-revalidate cache shared by every page: switching tabs shows the last answer instantly
// and refreshes it in the background. Identical in-flight requests are merged into one.
const cache = new Map<string, { data: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

function fetchShared<T>(secret: string, path: string): Promise<T> {
  const hit = inflight.get(path);
  if (hit) return hit as Promise<T>;
  const p = call<T>(secret, path)
    .then((d) => {
      cache.set(path, { data: d, at: Date.now() });
      return d;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

/**
 * GET `path` with the shared cache. `fresh` is how long (ms) a cached answer is used without refetching;
 * `poll` refetches on an interval while the tab is visible. Pass null to stay idle.
 */
export function useApi<T = any>(path: string | null, opts: { fresh?: number; poll?: number } = {}) {
  const { secret } = useSession();
  const { fresh = 15_000, poll } = opts;
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path)?.data as T | undefined) : undefined));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = useCallback(
    async (force: boolean) => {
      if (!path) return;
      const c = cache.get(path);
      if (c && !force && Date.now() - c.at < fresh) {
        setData(c.data as T);
        return;
      }
      if (c) setData(c.data as T);
      setLoading(true);
      try {
        const d = await fetchShared<T>(secret, path);
        if (alive.current) (setData(d), setError(""));
      } catch (e) {
        if (alive.current) setError(errMsg(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [secret, path, fresh],
  );

  useEffect(() => {
    if (!path) return setData(undefined);
    setData(cache.get(path)?.data as T | undefined);
    void run(false);
  }, [path, run]);

  useEffect(() => {
    if (!poll || !path) return;
    const t = setInterval(() => document.visibilityState === "visible" && void run(true), poll);
    return () => clearInterval(t);
  }, [poll, path, run]);

  const set = useCallback(
    (next: T | ((prev: T | undefined) => T)) => {
      setData((prev) => {
        const v = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
        if (path) cache.set(path, { data: v, at: Date.now() });
        return v;
      });
    },
    [path],
  );

  return { data, error, loading, reload: () => run(true), set };
}

export function useCopy() {
  const [done, setDone] = useState("");
  const copy = async (text: string, id = "x") => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(id);
      setTimeout(() => setDone(""), 1500);
    } catch {}
  };
  return { copied: done, copy };
}

export const when = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" }) : "—");
export const phoneOf = (me?: string) => (me ? `+${me.split(":")[0].split("@")[0]}` : "");
