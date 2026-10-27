// Inbound webhooks: an outside system starts a flow by calling /api/hooks/<flow id>.
// Each flow has its own secret (kept outside the flow, so exports never carry it). A request must be
// signed with it, must be recent, must not be a replay, and is rate limited per flow.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RawKV } from "../wa/auth";

const SECRET = "flow:hook:";
const NONCE = "flow:hooknonce:";
const RATE = "flow:hookrate:";

export const MAX_BODY = 64_000;
/** how far the sender's clock may be from ours, and how old a request may be */
export const MAX_SKEW_S = 300;
export const PER_MINUTE = 60;

export async function hookSecret(base: RawKV, flowId: string, create = false): Promise<string | null> {
  const have = await base.get(SECRET + flowId);
  if (have || !create) return have;
  const secret = "whsec_" + randomBytes(24).toString("hex");
  // nx: two saves racing must not end with two different secrets
  await base.set(SECRET + flowId, secret, { nx: true });
  return base.get(SECRET + flowId);
}

export async function rotateHookSecret(base: RawKV, flowId: string): Promise<string> {
  const secret = "whsec_" + randomBytes(24).toString("hex");
  await base.set(SECRET + flowId, secret);
  return secret;
}

export async function deleteHookSecret(base: RawKV, flowId: string) {
  await base.del(SECRET + flowId);
}

/** The value of the X-Signature header for a body sent at unix second `ts`. */
export const sign = (secret: string, ts: string | number, body: string) => "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

export function verify(secret: string, ts: string | null, signature: string | null, body: string, nowS = Math.floor(Date.now() / 1000)): "ok" | "stale" | "bad" {
  if (!ts || !signature || !/^\d{9,11}$/.test(ts)) return "bad";
  const want = Buffer.from(sign(secret, ts, body));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad";
  return Math.abs(nowS - Number(ts)) > MAX_SKEW_S ? "stale" : "ok";
}

/** True the first time a signature is seen. A copied request cannot be sent again inside the time window. */
export async function firstUse(base: RawKV, flowId: string, signature: string): Promise<boolean> {
  return (await base.set(`${NONCE}${flowId}:${signature.slice(-32)}`, "1", { ex: MAX_SKEW_S * 2, nx: true })) !== null;
}

export async function takeRate(base: RawKV, flowId: string, nowMs = Date.now()): Promise<boolean> {
  const key = `${RATE}${flowId}:${Math.floor(nowMs / 60_000)}`;
  const n = Number((await base.get(key)) ?? 0);
  if (n >= PER_MINUTE) return false;
  await base.set(key, String(n + 1), { ex: 120 });
  return true;
}

export type HookInput = {
  /** phone number or chat id the flow works on (optional) */
  to?: string;
  /** becomes {{text}} */
  text?: string;
  /** top-level fields of `data`, each becomes {{hook_<name>}} */
  data: Record<string, string>;
};

/** Throws an Error with a message for the caller. */
export function parseHookBody(body: string): HookInput {
  let raw: unknown;
  try {
    raw = body.trim() ? JSON.parse(body) : {};
  } catch {
    throw new Error("body must be JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const str = (v: unknown, max: number, name: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`${name} must be a string`);
    const s = String(v).trim();
    if (s.length > max) throw new Error(`${name} is longer than ${max} characters`);
    return s || undefined;
  };
  const data: Record<string, string> = {};
  if (b.data !== undefined) {
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw new Error("data must be an object");
    for (const [k, v] of Object.entries(b.data as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_]{1,30}$/.test(k)) throw new Error(`data.${k.slice(0, 30)}: names may use letters, digits and _ only`);
      if (Object.keys(data).length >= 20) throw new Error("data has more than 20 fields");
      if (v === null || typeof v === "object") continue; // only flat values become variables
      data[k] = String(v).slice(0, 500);
    }
  }
  return { to: str(b.to, 200, "to"), text: str(b.text, 4096, "text"), data };
}
