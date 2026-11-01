// What the marketing MCP tools and the dashboard API share: the saved customer
// list, template submission, and the storage guard.

import { randomUUID } from "node:crypto";
import type { Config } from "./config";
import type { Graph } from "./graph";
import type { DryRunRow } from "./campaign";
import { parseRecipientsFile, type ParsedRow } from "./recipients-file";
import type { Store } from "./store";
import { compileTemplate, type CompileResult, type TemplateDraft } from "./template-lint";

const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

/**
 * Campaign state has to survive between serverless calls. Without Redis the
 * store falls back to process memory, which is lost between requests and would
 * let a campaign resend; so nothing marketing-related runs without it.
 */
export function storageProblem(cfg: Config, env: Record<string, string | undefined> = process.env): string | null {
  if (cfg.redisUrl && cfg.redisToken) return null;
  if (env.ALLOW_MEMORY_STORE === "1") return null; // local development
  return "Campaigns need Upstash Redis: connect it in the Vercel Storage tab and redeploy. Without it campaign progress would be lost between requests and messages could be sent twice.";
}

export type UploadSummary = {
  uploadId: string;
  filename: string;
  rows: number;
  paramCount: number;
  warnings: string[];
  /** First rows with the phone masked, so the file can be recognised without exposing every number. */
  sample: { sourceRow: number; phone: string; consentAt: string; params: string[] }[];
};

const maskPhone = (p: unknown) => {
  const s = String(p ?? "");
  return s.length > 6 ? `${s.slice(0, 4)}****${s.slice(-3)}` : "****";
};
const isoOf = (d: Date | string | undefined) => (d instanceof Date ? d.toISOString() : (d ?? ""));

/** Parses a customer list and keeps it for 24 hours so a dry run can refer to it by id. */
export async function saveUpload(store: Store, data: Uint8Array, filename: string): Promise<UploadSummary> {
  const parsed = await parseRecipientsFile(data, filename);
  const uploadId = randomUUID();
  const rows: ParsedRow[] = parsed.rows.map((r) => ({ ...r, consentAt: isoOf(r.consentAt) || undefined }));
  await store.mkSet(`upload:${uploadId}`, { filename, paramCount: parsed.paramCount, rows }, { ex: UPLOAD_TTL_SECONDS });
  return {
    uploadId,
    filename,
    rows: rows.length,
    paramCount: parsed.paramCount,
    warnings: parsed.warnings,
    sample: rows.slice(0, 3).map((r) => ({ sourceRow: r.sourceRow, phone: maskPhone(r.phone), consentAt: isoOf(r.consentAt), params: r.params ?? [] })),
  };
}

export async function loadUpload(store: Store, uploadId: string): Promise<{ filename: string; paramCount: number; rows: DryRunRow[] } | null> {
  return store.mkGet(`upload:${uploadId}`);
}

export type SubmitResult =
  | Extract<CompileResult, { ok: false }>
  | (Extract<CompileResult, { ok: true }> & { submitted: boolean; meta?: { id: string; status: string; category: string } });

/** Lints a template draft and, when asked, sends it to Meta for review. A draft with errors is never sent. */
export async function submitTemplate(graph: Pick<Graph, "createTemplate">, draft: TemplateDraft, submit: boolean): Promise<SubmitResult> {
  const compiled = compileTemplate(draft);
  if (!compiled.ok) return compiled;
  if (!submit) return { ...compiled, submitted: false };
  return { ...compiled, submitted: true, meta: await graph.createTemplate(compiled.payload) };
}
