"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Mark } from "@/components/Mark";

const KEY = "whats-mcp-secret";

export function readSecret() {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Forgets the secret in this tab and on this device (the "remember me" copy), then reloads to the sign-in screen. */
export function forgetSecret() {
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {}
  location.reload();
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

/** Sends a file to /api/personal/upload in 2 MB pieces (a function takes at most 4.5 MB) and returns its upload id. */
export async function uploadPieces(secret: string, file: File | Blob, name: string, onProgress?: (percent: number) => void): Promise<string> {
  const PIECE = 2 * 1024 * 1024; // lib/upload.ts PIECE_BYTES
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
  const pieces = Math.max(1, Math.ceil(file.size / PIECE));
  for (let i = 0; i < pieces; i++) {
    const q = new URLSearchParams({ id, piece: String(i) });
    if (i === 0) for (const [k, v] of Object.entries({ name, mime: file.type, size: String(file.size), pieces: String(pieces) })) q.set(k, v);
    const r = await fetch(`/api/personal/upload?${q}`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/octet-stream" }, body: file.slice(i * PIECE, (i + 1) * PIECE) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    onProgress?.(Math.round(((i + 1) / pieces) * 100));
  }
  return id;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Status = {
  accounts: { id: string; label: string; paired: boolean; me?: string; name?: string; lastSync: number | null; cachedChats: number }[];
  storage: boolean;
  ai: boolean;
  cron: boolean;
  official: boolean;
  flowsPaused: boolean;
  secretWarning?: string | null;
  version?: { repo: string | null; commit: string | null; branch: string | null; env: string };
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
  const [show, setShow] = useState(false);
  const [restoring, setRestoring] = useState(true);

  const [remember, setRemember] = useState(false);

  const load = useCallback(async (s: string, keep?: boolean) => {
    setBusy(true);
    setError("");
    try {
      const st = await call<Status>(s, "/api/personal/status");
      setStatus(st);
      setSecret(s);
      try {
        sessionStorage.setItem(KEY, s);
        // undefined: restoring a saved secret, leave the device copy as it is
        if (keep === true) localStorage.setItem(KEY, s);
        else if (keep === false) localStorage.removeItem(KEY);
      } catch {}
    } catch (e) {
      try {
        sessionStorage.removeItem(KEY);
        localStorage.removeItem(KEY);
      } catch {}
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
      void load(s).finally(() => setRestoring(false));
    } else setRestoring(false);
  }, [load]);

  if (status && secret) {
    const reload = () => load(secret);
    return <SessionCtx.Provider value={{ secret, status, reload }}>{typeof children === "function" ? children(secret, status, reload) : children}</SessionCtx.Provider>;
  }
  // a secret kept from earlier in this tab: show a quiet loader instead of flashing the form
  if (restoring) return <div className="gate" aria-busy="true"><div className="gate-card"><div className="skel" style={{ height: 160 }} /></div></div>;
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          void load(input.trim(), remember);
        }}
      >
        <a className="mark" href="/"><Mark /> واتساب MCP</a>
        <div>
          <h1>لوحة التحكم</h1>
          <p className="muted">ادخل بكلمة السر <code>MCP_SECRET</code> اللي حطيتها في إعدادات فيرسل. تنحفظ في هذا التبويب بس، إلا إذا اخترت تذكرني.</p>
        </div>
        <label htmlFor="secret">كلمة السر</label>
        <div className="gate-input">
          <input
            id="secret"
            type={show ? "text" : "password"}
            dir="ltr"
            autoComplete="current-password"
            autoFocus
            value={input}
            onChange={(e) => (setInput(e.target.value), setError(""))}
            required
            minLength={24}
            aria-invalid={!!error}
            aria-describedby={error ? "secret-error" : undefined}
          />
          <button type="button" className="gate-eye" onClick={() => setShow(!show)} aria-label={show ? "إخفاء كلمة السر" : "إظهار كلمة السر"} aria-pressed={show}>
            {show ? "إخفاء" : "إظهار"}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          تذكرني على هذا الجهاز
        </label>
        {error && <p id="secret-error" className="banner bad" role="alert">{error === "Wrong or missing MCP_SECRET." ? "كلمة السر غلط. تأكد إنها نفس قيمة MCP_SECRET في فيرسل." : error}</p>}
        <button className="btn solid" type="submit" disabled={busy || input.trim().length < 24}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "نتحقق…" : "ادخل"}
        </button>
        <p className="hint">ما عندك كلمة سر؟ <a href="/guide">دليل الإعداد</a> يشرح كيف تسويها.</p>
      </form>
    </div>
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
