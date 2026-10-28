import { aiStatus } from "@/lib/flows/ai";
import { admin } from "@/lib/admin";
import { secretProblem } from "@/lib/access";
import { listAccounts } from "@/lib/wa/accounts";
import { isPaired } from "@/lib/wa/auth";
import { lastSync } from "@/lib/wa/session";
import { isPaused } from "@/lib/flows/storage";
import { versionInfo } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const accounts = await Promise.all(
    (await listAccounts(a.base)).map(async (acc) => {
      const d = a.account(acc.id);
      const [info, last, chats] = await Promise.all([isPaired(d.raw), lastSync(d.raw), d.store.countConversations(200)]);
      return { id: acc.id, label: acc.label, ...info, lastSync: last, cachedChats: chats };
    }),
  );
  return Response.json({
    accounts,
    storage: !!a.cfg.redisUrl,
    ai: aiStatus().claude || aiStatus().cheap,
    cron: !!process.env.CRON_SECRET,
    official: !!a.cfg.accessToken && !!a.cfg.phoneNumberId,
    flowsPaused: await isPaused(a.base),
    version: versionInfo(),
    secretWarning: secretProblem(a.cfg.mcpSecret),
  });
}
