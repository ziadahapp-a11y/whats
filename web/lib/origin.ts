import { headers } from "next/headers";

/** The address this deployment is being served from, e.g. https://whats-delta.vercel.app */
export async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (!host) return "https://YOUR-APP.vercel.app";
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
