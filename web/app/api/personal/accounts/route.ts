import { admin, err } from "@/lib/admin";
import { addAccount, isAccountId, listAccounts, removeAccount, renameAccount } from "@/lib/wa/accounts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  return Response.json({ accounts: await listAccounts(a.base) });
}

// Add another WhatsApp number (it still has to be linked with a pairing code).
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { label } = (await req.json().catch(() => ({}))) as { label?: string };
  try {
    return Response.json({ account: await addAccount(a.base, label ?? "") });
  } catch (e) {
    return err(e, 400);
  }
}

export async function PATCH(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { id, label } = (await req.json().catch(() => ({}))) as { id?: string; label?: string };
  try {
    await renameAccount(a.base, id ?? "", label ?? "");
    return Response.json({ ok: true });
  } catch (e) {
    return err(e, 400);
  }
}

export async function DELETE(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isAccountId(id)) return err("bad id", 400);
  await removeAccount(a.base, id);
  return Response.json({ removed: id });
}
