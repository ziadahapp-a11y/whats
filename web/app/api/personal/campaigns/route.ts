import { admin, err } from "@/lib/admin";
import { advanceCampaign, campaignReport, createDryRun, listCampaigns, resumeCampaign, startCampaign, stopCampaign } from "@/lib/campaign";
import { GraphError } from "@/lib/graph";
import { loadUpload, saveUpload, storageProblem, submitTemplate } from "@/lib/marketing";
import { normalizeSaudiMobile } from "@/lib/preflight";
import { RecipientsFileError } from "@/lib/recipients-file";
import { runtime } from "@/lib/runtime";
import type { TemplateDraft } from "@/lib/template-lint";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

function explain(e: unknown) {
  if (e instanceof RecipientsFileError) return fail(e.message);
  if (e instanceof GraphError) return fail(`WhatsApp API error${e.code ? ` ${e.code}` : ""}: ${e.message}`, e.status >= 400 && e.status < 600 ? e.status : 502);
  return err(e);
}

// The dashboard's marketing API: master key only, official-mode store, never without Redis.
export async function GET(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { cfg, store, graph } = runtime();
  const problem = storageProblem(cfg);
  if (problem) return fail(problem, 503);
  const url = new URL(req.url);
  try {
    const id = url.searchParams.get("id");
    if (id) {
      const r = await campaignReport({ graph, store }, id);
      return r ? Response.json(r) : fail("Campaign not found.", 404);
    }
    // overview: what the page needs to start. Each part fails on its own, so a Meta hiccup does not blank the page.
    const [number, templates, campaigns] = await Promise.all([
      graph.phoneInfo().then((p: any) => ({ ok: true as const, ...p })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
      graph.listTemplates(undefined, 100).then((t) => ({ ok: true as const, data: t.data as any[] })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
      listCampaigns({ graph, store }, 20),
    ]);
    return Response.json({
      number,
      templates: templates.ok ? { ok: true, data: templates.data.map((t) => ({ name: t.name, language: t.language, status: t.status, category: t.category })) } : templates,
      campaigns,
    });
  } catch (e) {
    return explain(e);
  }
}

export async function POST(req: Request) {
  const a = await admin(req);
  if (a instanceof Response) return a;
  const { cfg, store, graph } = runtime();
  const problem = storageProblem(cfg);
  if (problem) return fail(problem, 503);
  const deps = { graph, store };

  try {
    // a customer list: multipart with one "file"
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const file = (await req.formData()).get("file");
      if (!(file instanceof File)) return fail("Attach the customer list as a file field named \"file\".");
      return Response.json(await saveUpload(store, new Uint8Array(await file.arrayBuffer()), file.name));
    }

    const body: any = await req.json().catch(() => null);
    if (!body || typeof body.op !== "string") return fail("Send JSON with an op.");

    switch (body.op) {
      case "dry_run": {
        const up = await loadUpload(store, String(body.uploadId ?? ""));
        if (!up) return fail("The uploaded list is gone (they are kept 24 hours); upload it again.", 404);
        const r = await createDryRun(deps, { template: { name: String(body.template ?? ""), language: String(body.language ?? "ar") }, rows: up.rows });
        return Response.json(r);
      }
      case "start": {
        const r = await startCampaign(deps, String(body.id ?? ""), String(body.token ?? ""));
        return r.ok ? Response.json(r.campaign) : fail(`${r.error}${r.checks ? ` (${r.checks.map((c) => c.message).join(" ")})` : ""}`, 409);
      }
      case "advance":
        return Response.json(await advanceCampaign(deps, String(body.id ?? "")));
      case "control": {
        const id = String(body.id ?? "");
        if (body.action === "resume") {
          const r = await resumeCampaign(deps, id);
          return r.ok ? Response.json(r.campaign) : fail(r.error, 409);
        }
        if (body.action === "pause" || body.action === "cancel") return Response.json(await stopCampaign(deps, id, body.action));
        return fail("action must be pause, resume or cancel.");
      }
      case "template": {
        const d = body.draft as TemplateDraft | undefined;
        if (!d || typeof d.name !== "string" || typeof d.language !== "string" || typeof d.body !== "string") return fail("The template needs a name, language and body.");
        if ((d.buttons ?? []).some((b) => typeof b?.text !== "string")) return fail("Every button needs text.");
        const r = await submitTemplate(graph, d, body.submit === true);
        return Response.json(r);
      }
      case "opt": {
        const phone = normalizeSaudiMobile(body.phone);
        if (!phone) return fail("That is not a Saudi mobile number.");
        if (body.action === "opt_in") await store.recordOptIn(phone);
        else await store.recordOptOut(phone, String(body.reason ?? "set from the dashboard"));
        return Response.json({ optedOut: (await store.optedOut([phone])).has(phone) });
      }
      default:
        return fail(`Unknown op "${body.op}".`);
    }
  } catch (e) {
    return explain(e);
  }
}
