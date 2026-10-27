import { admin, err, pickAccount } from "@/lib/admin";
import { pair, type PairEvent } from "@/lib/wa/pair";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Streams newline-delimited JSON: the pairing code first, then progress.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { phone, account } = (await req.json().catch(() => ({}))) as { phone?: string; account?: string };
  if (!phone) return err("phone is required", 400);
  const acc = await pickAccount(a, account);
  if (acc instanceof Response) return acc;

  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = (e: PairEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await pair(acc.deps.raw, acc.deps.store, phone, emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
