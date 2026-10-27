import { timingSafeEqual } from "node:crypto";
import { loadFile } from "@/lib/files";
import { personal } from "@/lib/runtime";

export const dynamic = "force-dynamic";

// A temporary link (24 hours, secret token) so a connector can fetch a photo or file you sent.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const f = await loadFile(personal().base, id);
  const ok = f && t.length === f.token.length && timingSafeEqual(Buffer.from(t), Buffer.from(f.token));
  if (!f || !ok) return new Response("Not found", { status: 404 });
  const safe = f.name.replace(/[^\w.\- ]+/g, "_");
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": `inline; filename="${safe}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
