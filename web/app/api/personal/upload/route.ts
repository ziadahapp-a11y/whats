import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { admin, err } from "@/lib/admin";
import { MEDIA_RULES, type MediaKind } from "@/lib/media";

export const dynamic = "force-dynamic";

// Hands the browser a short-lived token to put one attachment straight into Vercel Blob, so files
// up to Meta's 100 MB limit never pass through a function. Meta then fetches the file by its URL.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return err("ربط Vercel Blob غير مفعّل: أنشئ Blob store من تبويب Storage في Vercel واربطه بالمشروع، ثم أعد النشر.", 503);
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return err("bad request", 400);
  try {
    return Response.json(
      await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (_pathname, payload) => {
          const rule = MEDIA_RULES[payload as MediaKind];
          if (!rule) throw new Error("unknown attachment kind");
          return { allowedContentTypes: rule.types, maximumSizeInBytes: rule.maxBytes, addRandomSuffix: true, validUntil: Date.now() + 10 * 60_000 };
        },
      }),
    );
  } catch (e) {
    return err(e, 400);
  }
}
