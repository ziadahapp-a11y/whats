import { admin, err } from "@/lib/admin";
import { listConnectors, publicView, removeConnector, saveConnector } from "@/lib/connectors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  return Response.json({ connectors: (await listConnectors(a.base)).map(publicView) });
}

// { name, url, token? }  (an existing name is updated; an empty token keeps the old one)
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as { name?: string; url?: string; token?: string };
  try {
    await saveConnector(a.base, { name: b.name ?? "", url: b.url ?? "", token: b.token });
    return Response.json({ ok: true });
  } catch (e) {
    return err(e, 400);
  }
}

export async function DELETE(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  await removeConnector(a.base, new URL(req.url).searchParams.get("name") ?? "");
  return Response.json({ ok: true });
}
