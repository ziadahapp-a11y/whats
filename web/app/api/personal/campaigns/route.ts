import { admin, err } from "@/lib/admin";
import { advanceCampaign, campaignReport, createDryRun, listCampaigns, resumeCampaign, startCampaign, stopCampaign, templateShape, type MediaKind, type SendOptions } from "@/lib/campaign";
import { GraphError } from "@/lib/graph";
import { loadUpload, saveUpload, storageProblem, submitTemplate } from "@/lib/marketing";
import { normalizeSaudiMobile } from "@/lib/preflight";
import { RecipientsFileError } from "@/lib/recipients-file";
import { runtime } from "@/lib/runtime";
import type { TemplateDraft } from "@/lib/template-lint";
import { dropUpload, loadUpload as loadPieces } from "@/lib/upload";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

// What Meta accepts in a template header, per kind (Cloud API media limits). Documents are PDF only here.
const MEDIA_RULES: Record<MediaKind, { mimes: string[]; maxBytes: number; label: string }> = {
  image: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024, label: "الصورة لازم JPG أو PNG وأقل من 5 ميقا." },
  video: { mimes: ["video/mp4", "video/3gpp"], maxBytes: 16 * 1024 * 1024, label: "الفيديو لازم MP4 وأقل من 16 ميقا." },
  document: { mimes: ["application/pdf"], maxBytes: 100 * 1024 * 1024, label: "الملف لازم PDF وأقل من 100 ميقا." },
};
const isMediaKind = (k: unknown): k is MediaKind => k === "image" || k === "video" || k === "document";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

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
      templates: templates.ok
        ? {
            ok: true,
            data: templates.data.map((t) => {
              const shape = templateShape(t.components ?? []);
              return { name: t.name, language: t.language, status: t.status, category: t.category, ...("error" in shape ? { unsupported: shape.error } : { shape }) };
            }),
          }
        : templates,
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
        // The header file: a public link, a media id from an earlier dry run, or a file the page just uploaded in pieces.
        // An uploaded file goes to Meta once; its media id comes back so a second dry run does not upload it again.
        const send: SendOptions = { headerText: str(body.headerText), buttonParam: str(body.buttonParam) };
        let mediaId: string | undefined;
        if (body.media) {
          const kind = body.media.kind;
          if (!isMediaKind(kind)) return fail("media.kind must be image, video or document.");
          const filename = str(body.media.filename);
          if (body.media.upload) {
            const id = String(body.media.upload);
            const file = await loadPieces(a.base, id);
            if (!file) return fail("الملف ما وصل كامل أو انتهت صلاحيته، اختره مرة ثانية.");
            try {
              const rule = MEDIA_RULES[kind];
              if (!rule.mimes.includes(file.mime) || file.size > rule.maxBytes) return fail(rule.label);
              mediaId = await graph.uploadMedia(file.bytes, file.mime, file.name);
              send.media = { kind, id: mediaId, ...(kind === "document" ? { filename: filename || file.name } : {}) };
            } finally {
              await dropUpload(a.base, id);
            }
          } else {
            send.media = { kind, link: str(body.media.link), id: str(body.media.id), ...(filename ? { filename } : {}) };
          }
        }
        const r = await createDryRun(deps, { template: { name: String(body.template ?? ""), language: String(body.language ?? "ar") }, rows: up.rows, send });
        return Response.json({ ...r, ...(mediaId ? { mediaId } : {}) });
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
        // An IMAGE header: the sample image was uploaded in pieces from the page (lib/upload.ts).
        if (body.headerUpload) {
          const id = String(body.headerUpload);
          if (body.submit !== true) d.header = { type: "IMAGE", handle: "checked-on-submit" };
          else {
            const img = await loadPieces(a.base, id);
            if (!img) return fail("صورة الرأس ما وصلت كاملة أو انتهت صلاحيتها، اخترها مرة ثانية.");
            try {
              if (!["image/jpeg", "image/png"].includes(img.mime) || img.size > 5 * 1024 * 1024) return fail("صورة الرأس لازم JPG أو PNG وأقل من 5 ميقا.");
              d.header = { type: "IMAGE", handle: await graph.uploadHeaderHandle(img.bytes, img.mime, img.name) };
            } finally {
              await dropUpload(a.base, id);
            }
          }
        }
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
