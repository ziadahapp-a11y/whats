import { admin, err } from "@/lib/admin";
import { target, targets } from "@/lib/inbox";
import { aiStatus } from "@/lib/flows/ai";
import { isPaused, listFlows } from "@/lib/flows/storage";
import { buildOverview, type OverviewAccount } from "@/lib/overview";
import { isPaired } from "@/lib/wa/auth";
import { lastSync } from "@/lib/wa/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The last 24 hours across every number, for the overview page.
export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  try {
    const accounts = (
      await Promise.all(
        (await targets(a)).map(async (row): Promise<OverviewAccount | null> => {
          const t = await target(a, row.id);
          if (!t) return null;
          const base = { id: t.id, label: row.label, kind: t.kind, store: t.store, state: t.state };
          return t.kind === "personal" ? { ...base, paired: (await isPaired(t.state)).paired, lastSync: await lastSync(t.state) } : base;
        }),
      )
    ).filter((x): x is OverviewAccount => !!x);
    const flows = await listFlows(a.base);
    const ai = aiStatus();
    return Response.json({
      ...(await buildOverview(accounts, Date.now(), new Map(flows.map((f) => [f.id, f.name])))),
      flows: { total: flows.length, enabled: flows.filter((f) => f.enabled).length, paused: await isPaused(a.base) },
      ai: { configured: ai.claude || ai.cheap, dailyCap: Number(process.env.AI_MAX_PER_DAY) || 300 },
    });
  } catch (e) {
    return err(e);
  }
}
