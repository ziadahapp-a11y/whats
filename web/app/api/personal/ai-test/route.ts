import { admin, err } from "@/lib/admin";
import { aiFromEnv, aiStatus } from "@/lib/flows/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sends one tiny question to each configured AI provider so a wrong key or model name shows up at once.
export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const st = aiStatus();
  const ai = aiFromEnv();
  if (!ai) return err("No AI key is set. Add ANTHROPIC_API_KEY or AI_COMPAT_URL / AI_COMPAT_KEY / AI_COMPAT_MODEL, then redeploy.", 503);
  const results: { provider: string; ok: boolean; detail: string }[] = [];
  for (const p of [st.claude && "claude", st.cheap && "cheap"].filter(Boolean) as ("claude" | "cheap")[]) {
    try {
      const out = await ai({ system: "Answer in one short word.", user: "Say OK.", maxTokens: 16, provider: p });
      results.push({ provider: p, ok: true, detail: out.slice(0, 60) });
    } catch (e) {
      results.push({ provider: p, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return Response.json({ results });
}
