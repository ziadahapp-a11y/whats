import { timingSafeEqual } from "node:crypto";

/**
 * The MCP endpoint accepts the secret either as `Authorization: Bearer <secret>`
 * (Claude Code, Cursor) or as `?key=<secret>` in the URL, for clients that can
 * only be given a URL. Refuses everything when no secret is configured, so a
 * fresh deployment is never an open relay for someone's WhatsApp number.
 */
export function isAuthorized(req: Request, secret: string): boolean {
  if (!secret || secret.length < 24) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  return safeEqual(bearer, secret) || safeEqual(key, secret);
}

function safeEqual(a: string, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
