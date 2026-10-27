import { normalizePhone } from "@/lib/graph";
import { runWebhookFlow, type Channel, type EngineDeps } from "@/lib/flows/engine";
import { MAX_BODY, PER_MINUTE, firstUse, hookSecret, parseHookBody, takeRate, verify } from "@/lib/flows/hooks";
import { isPaused, listFlows } from "@/lib/flows/storage";
import { engineExtras, officialChannel, personalChannel } from "@/lib/flows/sync";
import { personal, rawFor, runtime } from "@/lib/runtime";
import { listAccounts, OFFICIAL, scopeRaw } from "@/lib/wa/accounts";
import { isPaired } from "@/lib/wa/auth";
import { toJid, withWhatsApp } from "@/lib/wa/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const no = (status: number, error: string) => Response.json({ error }, { status });

// POST /api/hooks/<flow id>
//   X-Timestamp: unix seconds
//   X-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the flow's secret>
//   body: { "to": "9665…" (optional), "text": "…" (optional), "data": { "order": "1234", … } (optional) }
// Unknown, switched-off and non-webhook flows all answer the same 404, so ids cannot be probed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return no(413, `body is larger than ${MAX_BODY} bytes`);
  const body = await req.text();
  if (body.length > MAX_BODY) return no(413, `body is larger than ${MAX_BODY} bytes`);

  const { cfg, base, account } = personal();
  if (!cfg.redisUrl && process.env.ALLOW_MEMORY_STORE !== "1") return no(503, "storage is not configured");
  const flow = /^[a-z0-9-]{4,40}$/.test(id) ? (await listFlows(base)).find((f) => f.id === id && f.enabled && f.trigger.type === "webhook") : undefined;
  const secret = flow ? await hookSecret(base, id) : null;
  if (!flow || !secret) return no(404, "unknown hook");

  const signature = req.headers.get("x-signature");
  const check = verify(secret, req.headers.get("x-timestamp"), signature, body);
  if (check === "bad") return no(401, "bad or missing signature");
  if (check === "stale") return no(401, "X-Timestamp is more than 5 minutes off");
  if (!(await firstUse(base, id, signature!))) return no(409, "this exact request was already received");
  if (!(await takeRate(base, id))) return no(429, `more than ${PER_MINUTE} requests a minute for this flow`);
  if (await isPaused(base)) return no(503, "flows are paused");

  let input;
  try {
    input = parseHookBody(body);
  } catch (e) {
    return no(400, e instanceof Error ? e.message : String(e));
  }

  try {
    const accId = flow.account === "*" ? "main" : flow.account;
    let entry;
    if (accId === OFFICIAL) {
      if (!cfg.accessToken || !cfg.phoneNumberId) return no(503, "the official number is not configured");
      const { store, graph } = runtime();
      const b = rawFor(cfg);
      const io = { base: b, store, graph, normalize: normalizePhone, state: scopeRaw(b, "off:") };
      entry = await runWebhookFlow(flow, input, { flows: [flow], state: io.state, store, channel: officialChannel(io), ...engineExtras(b) });
    } else {
      if (!(await listAccounts(base)).some((a) => a.id === accId)) return no(503, "the flow's number does not exist");
      const d = account(accId);
      const paired = await isPaired(d.raw);
      if (!paired.paired) return no(503, "the flow's number is not linked");
      const deps = (channel: Channel): EngineDeps => ({ flows: [flow], state: d.raw, store: d.store, channel, ...engineExtras(base) });
      if (flow.mode === "auto") {
        // only auto mode sends, so only auto mode pays for opening a WhatsApp connection
        entry = (await withWhatsApp(d, (sock) => runWebhookFlow(flow, input, deps(personalChannel(sock, d))), { drain: false })).result;
      } else {
        const offline: Channel = {
          account: d.id, kind: "personal", me: paired.me?.split("@")[0].split(":")[0],
          sendText: async () => { throw new Error("sending needs auto mode"); },
          react: async () => {},
          markRead: async () => {},
          resolveTarget: toJid,
        };
        entry = await runWebhookFlow(flow, input, deps(offline));
      }
    }
    return Response.json({ ok: true, run: entry?.id ?? null, status: entry?.status ?? "no_action" }, { status: 202 });
  } catch (e) {
    return no(500, e instanceof Error ? e.message : String(e));
  }
}
