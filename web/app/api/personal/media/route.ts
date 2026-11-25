import { admin, err } from "@/lib/admin";
import { target } from "@/lib/inbox";
import { runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Streams one stored media message (image, audio, video, document, sticker) for the inbox.
// GET ?account=<id>&id=<message id>. Only Cloud API messages carry a media id to download.
export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const p = new URL(req.url).searchParams;
  const t = await target(a, p.get("account"));
  if (!t) return err("Unknown number.", 404);
  const id = p.get("id") ?? "";
  if (!id) return err("id is required", 400);
  try {
    const m = await t.store.getMessage(id);
    if (!m || !m.mediaId) return err("No media for this message.", 404);
    if (t.kind !== "official") return err("Media download is only available for the Cloud API number.", 400);
    const { meta, bytes } = await runtime().graph.downloadMedia(m.mediaId);
    if (!bytes) return err("The file is larger than 5 MB.", 413);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": m.mime || meta.mime_type || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        ...(m.filename ? { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(m.filename)}` } : {}),
      },
    });
  } catch (e) {
    return err(e);
  }
}
