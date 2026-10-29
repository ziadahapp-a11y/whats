import { admin, err } from "@/lib/admin";
import { publicBase } from "@/lib/files";
import { authUrl, connection, disconnect, getSettings, googleConfigured, redirectUri, saveSettings, type Settings } from "@/lib/gcal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  return Response.json({ configured: googleConfigured(), redirectUri: redirectUri(publicBase()), ...(await connection(a.base)), settings: await getSettings(a.base) });
}

// { op: "connect" } -> { url } to open; { op: "settings", settings }; { op: "disconnect" }
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const b = (await req.json().catch(() => ({}))) as { op?: string; settings?: Partial<Settings> };
  try {
    if (b.op === "connect") {
      if (!googleConfigured()) throw new Error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel, then redeploy.");
      return Response.json({ url: await authUrl(a.base, publicBase()) });
    }
    if (b.op === "settings") return Response.json({ settings: await saveSettings(a.base, b.settings ?? {}) });
    if (b.op === "disconnect") return await disconnect(a.base), Response.json({ ok: true });
    throw new Error("unknown op");
  } catch (e) {
    return err(e, 400);
  }
}
