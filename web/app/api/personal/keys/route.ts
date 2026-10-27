import { createDeviceKey, listDeviceKeys, revokeDeviceKey, type Scope } from "@/lib/access";
import { admin, err } from "@/lib/admin";
import { listAccounts } from "@/lib/wa/accounts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  return Response.json({ keys: await listDeviceKeys(a.base) });
}

// Creates a key for one device or person. The key itself is shown once, here.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const body = (await req.json().catch(() => ({}))) as { label?: string; accounts?: string[] | "*"; scope?: Scope };
  const known = new Set((await listAccounts(a.base)).map((x) => x.id));
  const accounts = body.accounts === "*" || !body.accounts ? "*" : body.accounts.filter((id) => known.has(id));
  try {
    const { token, key } = await createDeviceKey(a.base, { label: body.label ?? "", accounts, scope: body.scope === "read" ? "read" : "full" });
    const origin = new URL(req.url).origin;
    return Response.json({ key, token, url: `${origin}/api/personal/mcp?key=${token}` });
  } catch (e) {
    return err(e, 400);
  }
}

export async function DELETE(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const ok = await revokeDeviceKey(a.base, new URL(req.url).searchParams.get("id") ?? "");
  return ok ? Response.json({ revoked: true }) : err("no such key", 404);
}
