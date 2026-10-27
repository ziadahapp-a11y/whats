import { admin, pickAccount } from "@/lib/admin";
import { clearAuth } from "@/lib/wa/auth";
import { withWhatsApp } from "@/lib/wa/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Logs one number out of WhatsApp and deletes its stored session keys.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { account } = (await req.json().catch(() => ({}))) as { account?: string };
  const acc = await pickAccount(a, account);
  if (acc instanceof Response) return acc;
  try {
    await withWhatsApp(acc.deps, (sock) => sock.logout(), { drain: false, maxMs: 30_000 });
  } catch {
    /* already logged out or unreachable: still forget it locally */
  }
  await clearAuth(acc.deps.raw);
  return Response.json({ unlinked: true, account: acc.id });
}
