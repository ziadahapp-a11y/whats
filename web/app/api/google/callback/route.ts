import { rawFor, runtime } from "@/lib/runtime";
import { publicBase } from "@/lib/files";
import { finishAuth } from "@/lib/gcal";

export const dynamic = "force-dynamic";

// Google sends the browser back here after consent; the one-time state proves the dashboard started it.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const back = (msg: string) => Response.redirect(`${publicBase() || u.origin}/personal/knowledge?calendar=${encodeURIComponent(msg)}`, 302);
  if (u.searchParams.get("error")) return back(`رفضت Google الربط: ${u.searchParams.get("error")}`);
  try {
    const email = await finishAuth(rawFor(runtime().cfg), u.searchParams.get("code") ?? "", u.searchParams.get("state") ?? "", publicBase() || u.origin);
    return back(`تم ربط التقويم${email ? ` (${email})` : ""}`);
  } catch (e) {
    return back(e instanceof Error ? e.message : String(e));
  }
}
