// Outbound requests to addresses a user typed (webhooks, knowledge links).
// Only public https hosts are allowed, so a flow can never be pointed at
// Vercel's internal network, localhost or a router.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
  return false;
}

/** Cheap check without DNS: https only, no localhost or literal private IPs. */
export function literalCheck(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null;
  if (isIP(h) && isPrivateIp(h)) return null;
  return u.toString();
}

type Resolver = (host: string) => Promise<string[]>;
const dnsResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** literalCheck plus a DNS lookup, so a public-looking name cannot point at a private address. */
export async function assertPublicUrl(raw: string, resolve: Resolver = dnsResolve): Promise<string> {
  const ok = literalCheck(raw);
  if (!ok) throw new Error("The address must be a public https URL.");
  const host = new URL(ok).hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host)) {
    let ips: string[];
    try {
      ips = await resolve(host);
    } catch {
      throw new Error(`Could not resolve ${host}.`);
    }
    if (!ips.length || ips.some(isPrivateIp)) throw new Error("The address must be a public https URL.");
  }
  return ok;
}

export type Fetched = { url: string; status: number; contentType: string; bytes: Uint8Array };

/** GET with a size cap, a timeout and manual redirects that are re-checked at every hop. */
export async function safeGet(raw: string, opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; fetchImpl?: typeof fetch; resolve?: Resolver } = {}): Promise<Fetched> {
  const { maxBytes = 5 * 1024 * 1024, timeoutMs = 15_000, maxRedirects = 3, fetchImpl = fetch, resolve } = opts;
  let url = await assertPublicUrl(raw, resolve);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "whats-mcp-knowledge/1.0", Accept: "text/html,application/pdf,text/plain,text/markdown,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString(), resolve);
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return { url, status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: new Uint8Array(await res.arrayBuffer()) };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) (bytes.set(c, o), (o += c.length));
    return { url, status: res.status, contentType: res.headers.get("content-type") ?? "", bytes };
  }
  throw new Error("Too many redirects.");
}
