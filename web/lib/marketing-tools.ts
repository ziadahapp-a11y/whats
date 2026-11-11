// MCP tools for marketing on the official Cloud API: templates, campaigns, opt-outs.
// Every tool that can reach customers says so in its description, and campaigns
// can only start from a dry run whose token the person has seen.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { advanceCampaign, campaignReport, createDryRun, listCampaigns, resumeCampaign, startCampaign, stopCampaign, type CampaignDeps, type DryRunRow } from "./campaign";
import type { Config } from "./config";
import { GraphError, type Graph } from "./graph";
import { loadUpload, storageProblem, submitTemplate } from "./marketing";
import { normalizeSaudiMobile } from "./preflight";
import type { Store } from "./store";
import type { TemplateDraft } from "./template-lint";

type Deps = { graph: Graph; store: Store; cfg: Config };

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const META = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
/** Reaches real customers and is billed by Meta. */
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function explain(e: unknown): string {
  if (e instanceof GraphError) {
    if (e.code === 190) return `${e.message}. The access token is invalid or expired: generate a new System User token and update WHATSAPP_ACCESS_TOKEN.`;
    return `WhatsApp API error${e.code ? ` ${e.code}` : ""}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const NEXT: Record<string, string> = {
  dry_run: "Not started. Show the person the report; only with their approval call campaign_start with the confirm token.",
  running: "More to send: call campaign_advance again.",
  waiting: "The pilot batch is out. Check campaign_report (delivery and errors); once resumeAt has passed, call campaign_advance to continue.",
  halted: "Stopped. Read haltReason and find the cause first; resume only with the person's approval (campaign_control action=resume).",
  completed: "Finished. campaign_report has delivery results; they keep arriving for a while.",
  cancelled: "Cancelled.",
};

const buttonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().describe('up to 25 characters, e.g. "إيقاف" for an opt-out button') }),
  z.object({ type: z.literal("URL"), text: z.string(), url: z.string().describe("https URL; may end with {{1}}"), url_example: z.string().optional().describe("a full sample URL, required when the url ends with {{1}}") }),
  z.object({ type: z.literal("PHONE_NUMBER"), text: z.string(), phone: z.string().describe("international format with +, e.g. +966500000000") }),
]);

export function registerMarketingTools(server: McpServer, { graph, store, cfg }: Deps) {
  const deps: CampaignDeps = { graph, store };
  const guard = () => storageProblem(cfg);

  // ---- templates ---------------------------------------------------------

  server.registerTool(
    "create_template",
    {
      title: "Check or submit a marketing template",
      description:
        "Checks a marketing template against Meta's rejection rules and, with submit=true, sends it to Meta for review (category MARKETING). Without submit it only returns the problems and the payload. Variables are {{1}}, {{2}}… in the body, never at its start or end, each with an example in body_examples. A quick-reply opt-out button is recommended. Meta decides approval (minutes to a day); a clean check does not guarantee it. Check progress with get_template_status.",
      inputSchema: z.object({
        name: z.string().describe("lowercase letters, digits and underscores; other characters are normalised"),
        language: z.string().default("ar").describe('Meta language code, e.g. "ar"'),
        header: z.string().optional().describe("plain-text header, up to 60 characters, no emoji or variables"),
        body: z.string().describe("message text, up to 1024 characters"),
        body_examples: z.array(z.string()).default([]).describe("one sample value per variable, in order"),
        footer: z.string().optional().describe("up to 60 characters, no variables"),
        buttons: z.array(buttonSchema).default([]),
        submit: z.boolean().default(false).describe("true to send it to Meta for review"),
      }),
      annotations: META,
    },
    async (a) => {
      try {
        const draft: TemplateDraft = {
          name: a.name,
          language: a.language,
          ...(a.header ? { header: { type: "TEXT" as const, text: a.header } } : {}),
          body: a.body,
          bodyExamples: a.body_examples,
          ...(a.footer ? { footer: a.footer } : {}),
          buttons: a.buttons.map((b) => (b.type === "URL" ? { type: "URL" as const, text: b.text, url: b.url, urlExample: b.url_example } : b)),
        };
        const r = await submitTemplate(graph, draft, a.submit);
        if (!r.ok) return fail(`Not sent. Fix these first:\n${JSON.stringify(r.issues, null, 2)}`);
        return json({ submitted: r.submitted, review: r.meta, variables: r.paramCount, warnings: r.warnings, ...(r.submitted ? {} : { payload: r.payload }) });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "get_template_status",
    {
      title: "Template review status",
      description: "Review status, category, quality and rejection reason of one template as Meta reports it. status is APPROVED, PENDING, REJECTED, PAUSED or DISABLED.",
      inputSchema: z.object({ name: z.string(), language: z.string().optional().describe('e.g. "ar"; omit to see every language') }),
      annotations: READ,
    },
    async ({ name, language }) => {
      try {
        const t = await graph.getTemplate(name, language);
        if (!t) return fail(`No template named "${name}"${language ? ` in ${language}` : ""}.`);
        return json({ name: t.name, language: t.language, status: t.status, category: t.category, quality: t.quality_score?.score, rejected_reason: t.rejected_reason });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a template",
      description: "Deletes every language version of the template with this name from Meta. It cannot be undone, and a deleted name cannot be reused for a while. Confirm with the person first.",
      inputSchema: z.object({ name: z.string() }),
      annotations: DELETE,
    },
    async ({ name }) => {
      try {
        return json(await graph.deleteTemplate(name));
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "register_number",
    {
      title: "Register the number on the Cloud API",
      description:
        "Registers the business number on the Cloud API with a 6-digit PIN you choose; it becomes the number's two-step verification PIN, so the person must keep it. Needed only when the number stays Pending after verification.",
      inputSchema: z.object({ pin: z.string().regex(/^\d{6}$/).describe("six digits") }),
      annotations: META,
    },
    async ({ pin }) => {
      try {
        return json(await graph.registerPhone(pin));
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  // ---- campaigns ---------------------------------------------------------

  server.registerTool(
    "campaign_dry_run",
    {
      title: "Check a campaign without sending",
      description:
        "Screens a customer list for a marketing campaign and sends NOTHING. Checks the number (connected, verified, GREEN quality), the template (approved MARKETING, body variables only), the messaging limit, and every recipient (Saudi mobile, consent, opt-out, 7-day cooldown, variable values). Use upload_id from the dashboard upload, or rows for a small list. When everything passes it returns a campaign_id and a confirm_token. Show the person the summary and the blocked rows before going further.",
      inputSchema: z.object({
        template_name: z.string(),
        language: z.string().default("ar"),
        upload_id: z.string().optional().describe("id shown after uploading the list in the dashboard (Campaigns page)"),
        rows: z
          .array(z.object({ phone: z.string(), consent_date: z.string().describe("YYYY-MM-DD, when the customer agreed"), params: z.array(z.string()).default([]).describe("values for {{1}}, {{2}}… in order") }))
          .max(200)
          .optional()
          .describe("for small lists only; each row asserts the customer consented through the dashboard"),
      }),
      annotations: WRITE,
    },
    async ({ template_name, language, upload_id, rows }) => {
      const problem = guard();
      if (problem) return fail(problem);
      if (!!upload_id === !!rows) return fail("Give exactly one of upload_id or rows.");
      try {
        let list: DryRunRow[];
        if (upload_id) {
          const up = await loadUpload(store, upload_id);
          if (!up) return fail("Upload not found or older than 24 hours; upload the list again.");
          list = up.rows;
        } else {
          list = rows!.map((r, i) => ({ phone: r.phone, consentSource: "dashboard", consentAt: r.consent_date, params: r.params, sourceRow: i + 1 }));
        }
        const r = await createDryRun(deps, { template: { name: template_name, language }, rows: list });
        const { blocked, ...rest } = r;
        return json({ ...rest, blocked: blocked.map((b) => ({ sourceRow: b.sourceRow, reason: b.reason, detail: b.detail })) });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "campaign_start",
    {
      title: "Start a checked campaign",
      description:
        "Starts a campaign from its dry run, after re-checking everything with current data. Needs the campaign_id and confirm_token that campaign_dry_run returned and the person has approved. This call sends nothing; messages go out only with campaign_advance.",
      inputSchema: z.object({ campaign_id: z.string(), confirm_token: z.string() }),
      annotations: WRITE,
    },
    async ({ campaign_id, confirm_token }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        const r = await startCampaign(deps, campaign_id, confirm_token);
        return r.ok ? json({ ...r.campaign, next: NEXT[r.campaign.status] }) : fail(`${r.error}${r.checks ? `\n${JSON.stringify(r.checks, null, 2)}` : ""}`);
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "campaign_advance",
    {
      title: "Send the next batch of a campaign",
      description:
        "SENDS real marketing messages to customers right now, for up to about 45 seconds, and they are billed by Meta. The first call sends only a small pilot batch and then waits a minute; later calls continue. A circuit breaker stops the campaign by itself on poor quality, Meta spam or pace errors, or too many failures. Call it again while status is running, and after resumeAt while waiting. Only for a campaign the person approved.",
      inputSchema: z.object({ campaign_id: z.string() }),
      annotations: SEND,
    },
    async ({ campaign_id }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        const v = await advanceCampaign(deps, campaign_id);
        return json({ ...v, next: v.busy ? "Another call is already sending for this campaign; wait a moment." : NEXT[v.status] });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "campaign_control",
    {
      title: "Pause, resume or cancel a campaign",
      description:
        "pause stops a running campaign at its next batch. resume continues a halted one, only if the number's quality is GREEN again, and the breaker then judges only what is sent from there. cancel ends the campaign for good and frees the account for another.",
      inputSchema: z.object({ campaign_id: z.string(), action: z.enum(["pause", "resume", "cancel"]) }),
      annotations: WRITE,
    },
    async ({ campaign_id, action }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        if (action === "resume") {
          const r = await resumeCampaign(deps, campaign_id);
          return r.ok ? json({ ...r.campaign, next: NEXT[r.campaign.status] }) : fail(r.error);
        }
        const v = await stopCampaign(deps, campaign_id, action);
        return json({ ...v, next: v.busy ? "A batch is in flight; it will stop at its next batch." : NEXT[v.status] });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "campaign_report",
    {
      title: "Campaign progress and delivery",
      description:
        "Progress, delivery and read counts, error codes with their meaning, and a sample of failures (numbers masked). Delivery updates arrive from Meta over time, so counts keep growing after the last message is sent.",
      inputSchema: z.object({ campaign_id: z.string() }),
      annotations: READ,
    },
    async ({ campaign_id }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        const r = await campaignReport(deps, campaign_id);
        return r ? json({ ...r, next: NEXT[r.status] }) : fail("Campaign not found.");
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description: "The most recent campaigns, newest first, with status and progress.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      annotations: READ,
    },
    async ({ limit }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        return json(await listCampaigns(deps, limit));
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  // ---- opt-outs ----------------------------------------------------------

  server.registerTool(
    "manage_opt_out",
    {
      title: "Opt a customer out or back in",
      description:
        "opt_out stops marketing messages to a number (customers who reply stop are handled automatically). opt_in records that the customer asked to receive them again; only use it when they actually did.",
      inputSchema: z.object({ phone: z.string().describe("Saudi mobile in any common spelling"), action: z.enum(["opt_out", "opt_in"]), reason: z.string().default("set by hand") }),
      annotations: WRITE,
    },
    async ({ phone, action, reason }) => {
      const problem = guard();
      if (problem) return fail(problem);
      const p = normalizeSaudiMobile(phone);
      if (!p) return fail(`"${phone}" is not a Saudi mobile number.`);
      try {
        if (action === "opt_out") await store.recordOptOut(p, reason);
        else await store.recordOptIn(p);
        return json({ phone: `${p.slice(0, 5)}****${p.slice(-3)}`, optedOut: (await store.optedOut([p])).has(p) });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );

  server.registerTool(
    "list_opt_outs",
    {
      title: "List opted-out numbers",
      description: "Numbers currently opted out of marketing, most recent first, with the reason. Numbers are masked.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
      annotations: READ,
    },
    async ({ limit }) => {
      const problem = guard();
      if (problem) return fail(problem);
      try {
        const all = await store.optOuts();
        return json({ total: all.length, optOuts: all.slice(0, limit).map((o) => ({ phone: `${o.phone.slice(0, 5)}****${o.phone.slice(-3)}`, at: new Date(o.at).toISOString(), reason: o.reason })) });
      } catch (e) {
        return fail(explain(e));
      }
    },
  );
}
