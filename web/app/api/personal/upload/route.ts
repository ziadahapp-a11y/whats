import { admin, err } from "@/lib/admin";
import { mediaProblem } from "@/lib/media";
import { PIECE_BYTES, putPiece } from "@/lib/upload";

export const dynamic = "force-dynamic";

// One piece of an attachment: POST ?id=<32 hex>&piece=<n> with the raw bytes as the body.
// Piece 0 also carries &name= &mime= &size= &pieces= describing the whole file.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const p = new URL(req.url).searchParams;
  const piece = Number(p.get("piece"));
  try {
    let meta;
    if (piece === 0) {
      meta = { name: (p.get("name") ?? "file").slice(0, 200), mime: p.get("mime") ?? "", size: Number(p.get("size")) || 0, pieces: Number(p.get("pieces")) || 0 };
      const problem = mediaProblem(meta.mime, meta.size);
      if (problem) return err(problem, 400);
      if (meta.pieces !== Math.max(1, Math.ceil(meta.size / PIECE_BYTES))) return err("bad piece count", 400);
    }
    const bytes = Buffer.from(await req.arrayBuffer());
    await putPiece(a.base, p.get("id") ?? "", piece, bytes, meta);
    return Response.json({ ok: true });
  } catch (e) {
    return err(e, 400);
  }
}
