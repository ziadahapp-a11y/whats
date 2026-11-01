// Marketing campaign runner for the official Cloud API.
//
// Flow: createDryRun screens the list and saves the campaign with a one-time
// token; startCampaign re-screens everything with fresh data and starts it;
// advanceCampaign sends in time-boxed slices (Vercel functions are short-lived),
// pausing for a pilot batch first; the circuit breaker can halt it at any point
// and only a person resumes it. State lives in Redis under "mk:camp:*".
//
// Nothing here sends on its own: advanceCampaign must be called, and only for a
// campaign that has been started with its dry-run token.

import { randomUUID } from "node:crypto";
import { DEFAULT_BREAKER, HALT_CODES, evaluate, parseErrorCode, type BreakerConfig, type Outcome } from "./breaker";
import { GraphError, type Graph } from "./graph";
import { normalizeSaudiMobile, preflight, type BlockedRow, type PreflightCheck, type PreflightReport, type RecipientRow } from "./preflight";
import type { Store } from "./store";

export type CampaignDeps = {
  graph: Pick<Graph, "sendMessage" | "phoneInfo" | "getTemplate" | "getTemplateInfo">;
  store: Store;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  breaker?: BreakerConfig;
};

export type CampaignStatus = "dry_run" | "running" | "waiting" | "halted" | "completed" | "cancelled";

export type CampaignRecipient = {
  phone: string;
  params: string[];
  /** This customer's value for a {{1}} in the template header; overrides the campaign-wide one. */
  headerParam?: string;
  /** This customer's value for the end of a URL button's link; overrides the campaign-wide one. */
  buttonParam?: string;
  sourceRow?: number;
  consentSource: string;
  /** ISO string */
  consentAt: string;
};

/** A media header's file: a public https link, or a media id from uploading the file to Meta. */
export type CampaignMedia = { kind: MediaKind; link?: string; id?: string; filename?: string };

/** What a send needs beyond the body variables, chosen once for the whole campaign. */
export type SendOptions = {
  media?: CampaignMedia;
  /** Value for the header's {{1}} when the list has no header_var column (or a row leaves it empty). */
  headerText?: string;
  /** Value for the end of every URL button link that has {{1}}, when the row has none. */
  buttonParam?: string;
};

type Campaign = {
  id: string;
  createdAt: number;
  status: CampaignStatus;
  template: { name: string; language: string; paramCount: number };
  /** The template's header and buttons as the send has to fill them. Absent on campaigns from before media support. */
  shape?: TemplateShape;
  send?: SendOptions;
  /** One-time token from the dry run; removed when the campaign starts. */
  confirmToken?: string;
  total: number;
  cursor: number;
  pilotSize: number;
  pilotDone: boolean;
  resumeAt?: number;
  /** Outcomes before this index are ignored by the breaker (set when a person resumes). */
  evalFrom: number;
  skipped: number;
  skippedBy: Record<string, number>;
  startedAt?: number;
  finishedAt?: number;
  haltReason?: string;
  haltCode?: number;
};

export type CampaignView = {
  id: string;
  status: CampaignStatus;
  template: Campaign["template"];
  total: number;
  cursor: number;
  remaining: number;
  sent: number;
  failed: number;
  skipped: number;
  skippedBy: Record<string, number>;
  pilotSize: number;
  resumeAt?: number;
  startedAt?: number;
  finishedAt?: number;
  haltReason?: string;
  haltCode?: number;
  /** Another slice is already running for this campaign; nothing was sent by this call. */
  busy?: boolean;
};

const PILOT_SHARE = 0.05;
const PILOT_MIN = 5;
const PILOT_WAIT_MS = 60_000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BLOCKED_SAMPLE = 200;
const STATUS_WINDOW = 400; // recent sends whose delivery status is re-read before each batch
const LIVE: CampaignStatus[] = ["running", "waiting", "halted"];

const key = (id: string, part = "") => `camp:${id}${part}`;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);

async function settle<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

// -- persistence -------------------------------------------------------------

async function load(store: Store, id: string): Promise<Campaign | null> {
  return store.mkGet<Campaign>(key(id));
}

function counts(outcomes: readonly Outcome[]) {
  const sent = outcomes.filter((o) => o.ok).length;
  return { sent, failed: outcomes.length - sent };
}

function view(c: Campaign, outcomes: readonly Outcome[], extra: Partial<CampaignView> = {}): CampaignView {
  return {
    id: c.id,
    status: c.status,
    template: c.template,
    total: c.total,
    cursor: c.cursor,
    remaining: c.total - c.cursor,
    ...counts(outcomes),
    skipped: c.skipped,
    skippedBy: c.skippedBy,
    pilotSize: c.pilotSize,
    resumeAt: c.resumeAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    haltReason: c.haltReason,
    haltCode: c.haltCode,
    ...extra,
  };
}

async function save(store: Store, c: Campaign, outcomes?: Outcome[]) {
  await store.mkSet(key(c.id), c);
  if (outcomes) await store.mkSet(key(c.id, ":o"), outcomes);
}

async function release(store: Store, id: string) {
  const active = await store.mkGet<string>("camp:active");
  if (active === id) {
    await store.mkSet("camp:active", "");
    await store.mkUnlock("active");
  }
}

/** The campaign currently holding the account (running, waiting or halted), if any. */
async function activeCampaign(store: Store): Promise<Campaign | null> {
  const id = await store.mkGet<string>("camp:active");
  const c = id ? await load(store, id) : null;
  return c && LIVE.includes(c.status) ? c : null;
}

/** Re-reads delivery statuses so a "failed" webhook update turns a send into a failure. Returns how many changed. */
async function refreshStatuses(store: Store, outcomes: Outcome[], recent = outcomes.length): Promise<number> {
  const targets = outcomes.slice(-recent).filter((o) => o.ok && o.messageId);
  if (!targets.length) return 0;
  const msgs = await store.messagesByIds(targets.map((o) => o.messageId!));
  let changed = 0;
  targets.forEach((o, i) => {
    const m = msgs[i];
    if (m?.status === "failed") {
      o.ok = false;
      o.errorCode = parseErrorCode(m.error);
      o.error = m.error;
      changed++;
    }
  });
  return changed;
}

// -- template ----------------------------------------------------------------

export type MediaKind = "image" | "video" | "document";

/** The parts of a template that need a value at send time, beyond the body variables. */
export type TemplateShape = {
  header: "none" | "text" | "text_var" | MediaKind;
  /** Indexes (in the template's button list) of URL buttons whose link ends with {{1}}. */
  urlVars: number[];
};

const MEDIA_FORMATS: Record<string, MediaKind> = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" };

/** Reads a template's components. Returns a reason instead when a part needs something campaigns cannot send. */
export function templateShape(components: any[]): TemplateShape | { error: string } {
  const shape: TemplateShape = { header: "none", urlVars: [] };
  for (const c of components) {
    if (!["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(c.type)) return { error: `Template has a ${c.type} component, which campaigns do not support yet.` };
    if (c.type === "HEADER") {
      if (c.format === "TEXT" || !c.format) shape.header = /\{\{/.test(c.text ?? "") ? "text_var" : "text";
      else if (MEDIA_FORMATS[c.format]) shape.header = MEDIA_FORMATS[c.format];
      else return { error: `Template has a ${c.format} header, which campaigns do not support yet.` };
    }
    if (c.type === "BUTTONS") {
      (c.buttons ?? []).forEach((b: any, i: number) => {
        if (b.type === "URL" && /\{\{/.test(b.url ?? "")) shape.urlVars.push(i);
      });
      const bad = (c.buttons ?? []).find((b: any) => !["QUICK_REPLY", "PHONE_NUMBER", "URL"].includes(b.type));
      if (bad) return { error: `Template has a ${bad.type} button, which campaigns do not support yet.` };
    }
  }
  return shape;
}

/** Kept for callers that only need a yes or no on the template's components. */
export function unsupportedReason(components: any[]): string | null {
  const s = templateShape(components);
  return "error" in s ? s.error : null;
}

const HEADER_TEXT_MAX = 60; // Meta's limit for the whole text header
const BAD_VALUE = /[\n\r\t]| {4,}/;

/** Problems with the campaign-wide send options or the per-row values the template needs. Each is a failing check. */
export function sendInputChecks(shape: TemplateShape, send: SendOptions | undefined, rows: readonly { headerParam?: string; buttonParam?: string; sourceRow?: number }[]): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  const kind = shape.header;
  const media = send?.media;
  const rowsList = (missing: typeof rows) => missing.slice(0, 10).map((r) => r.sourceRow ?? "?").join(", ") + (missing.length > 10 ? "…" : "");

  if (kind === "image" || kind === "video" || kind === "document") {
    if (!media || (!media.link && !media.id)) out.push({ id: "send.media", ok: false, message: `The template has a ${kind} header: add the ${kind} as a public https link or upload the file.` });
    else if (media.kind !== kind) out.push({ id: "send.media", ok: false, message: `The template's header is a ${kind}, but the file given is a ${media.kind}.` });
    else if (media.link && !/^https:\/\/\S+$/.test(media.link)) out.push({ id: "send.media", ok: false, message: "The media link must be a public https:// address." });
  } else if (media && (media.link || media.id)) {
    out.push({ id: "send.media", ok: false, message: "The template has no media header, so the file cannot be sent with it. Remove it or choose a template with an image, video or document header." });
  }

  if (kind === "text_var") {
    const fallback = send?.headerText?.trim() ?? "";
    const missing = rows.filter((r) => !(r.headerParam?.trim() || fallback));
    if (missing.length) out.push({ id: "send.header_var", ok: false, message: `The template header has {{1}}: fill the header value in the campaign form or a header_var column. Missing in rows ${rowsList(missing)}.` });
    const values = [fallback, ...rows.map((r) => r.headerParam ?? "")].filter(Boolean);
    if (values.some((v) => v.length > HEADER_TEXT_MAX || BAD_VALUE.test(v))) out.push({ id: "send.header_var", ok: false, message: `A header value is longer than ${HEADER_TEXT_MAX} characters or contains a newline or tab.` });
  }

  if (shape.urlVars.length) {
    const fallback = send?.buttonParam?.trim() ?? "";
    const missing = rows.filter((r) => !(r.buttonParam?.trim() || fallback));
    if (missing.length) out.push({ id: "send.button_var", ok: false, message: `The template's link button ends with {{1}}: fill the link value in the campaign form or a button_var column. Missing in rows ${rowsList(missing)}.` });
    const values = [fallback, ...rows.map((r) => r.buttonParam ?? "")].filter(Boolean);
    if (values.some((v) => /\s/.test(v.trim()) || v.length > 2000)) out.push({ id: "send.button_var", ok: false, message: "A link value contains spaces or is too long; it is added to the end of the link as is." });
  }
  return out;
}

function templateMessage(t: Campaign["template"], r: Pick<CampaignRecipient, "params" | "headerParam" | "buttonParam">, shape?: TemplateShape, send?: SendOptions) {
  const components: any[] = [];
  if (shape && (shape.header === "image" || shape.header === "video" || shape.header === "document") && send?.media) {
    const m = send.media;
    const file: Record<string, string> = m.id ? { id: m.id } : { link: m.link! };
    if (shape.header === "document" && m.filename) file.filename = m.filename;
    components.push({ type: "header", parameters: [{ type: shape.header, [shape.header]: file }] });
  } else if (shape?.header === "text_var") {
    components.push({ type: "header", parameters: [{ type: "text", text: (r.headerParam?.trim() || send?.headerText?.trim()) ?? "" }] });
  }
  if (r.params.length) components.push({ type: "body", parameters: r.params.map((text) => ({ type: "text", text })) });
  for (const index of shape?.urlVars ?? []) {
    components.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: (r.buttonParam?.trim() || send?.buttonParam?.trim()) ?? "" }] });
  }
  return {
    type: "template",
    template: {
      name: t.name,
      language: { code: t.language },
      ...(components.length ? { components } : {}),
    },
  };
}

// -- screening ---------------------------------------------------------------

export type DryRunRow = RecipientRow & { sourceRow?: number; headerParam?: string; buttonParam?: string };

/** Trims the options and drops empty ones, so a blank form field means "not given". */
function cleanSend(send?: SendOptions): SendOptions | undefined {
  if (!send) return undefined;
  const out: SendOptions = {};
  const m = send.media;
  if (m && (m.link?.trim() || m.id?.trim())) {
    out.media = { kind: m.kind, ...(m.id?.trim() ? { id: m.id.trim() } : { link: m.link!.trim() }), ...(m.filename?.trim() ? { filename: m.filename.trim() } : {}) };
  }
  if (send.headerText?.trim()) out.headerText = send.headerText.trim();
  if (send.buttonParam?.trim()) out.buttonParam = send.buttonParam.trim();
  return Object.keys(out).length ? out : undefined;
}

type Screen = {
  report: PreflightReport<DryRunRow>;
  checks: PreflightCheck[];
  ok: boolean;
  blocked: (BlockedRow & { sourceRow?: number })[];
  template: Campaign["template"] | null;
  shape: TemplateShape | null;
};

/** The full pre-send check against live data: Meta's view of the number and template, opt-outs, cooldown, capacity. */
async function screen(deps: CampaignDeps, tpl: { name: string; language: string }, rows: readonly DryRunRow[], now: number, send?: SendOptions): Promise<Screen> {
  const { graph, store } = deps;
  const phones = [...new Set(rows.map((r) => normalizeSaudiMobile(r.phone)).filter((p): p is string => !!p))];
  const [phone, info, raw, optedOut, lastMarketingAt, recent24h, active] = await Promise.all([
    settle(() => graph.phoneInfo()),
    settle(() => graph.getTemplateInfo(tpl.name, tpl.language)),
    settle(() => graph.getTemplate(tpl.name, tpl.language)),
    store.optedOut(phones),
    store.lastMarketing(phones),
    store.recentMarketing(24 * 60 * 60 * 1000, now),
    activeCampaign(store),
  ]);

  const report = preflight({ phone, template: info, language: tpl.language, rows, now, optedOut, lastMarketingAt, recent24h });

  const extra: PreflightCheck[] = [];
  const parsed = raw ? templateShape((raw as any).components ?? []) : null;
  const shape = parsed && !("error" in parsed) ? parsed : null;
  if (parsed && "error" in parsed) extra.push({ id: "template.components", ok: false, message: parsed.error });
  if (shape) extra.push(...sendInputChecks(shape, send, report.accepted as DryRunRow[]));
  if (active) extra.push({ id: "campaign.active", ok: false, message: `Campaign ${active.id} is ${active.status}; finish, cancel or resume it first.` });

  const checks = [...report.checks, ...extra];
  return {
    report,
    checks,
    ok: report.ok && extra.length === 0,
    blocked: report.blocked.map((b) => ({ ...b, sourceRow: rows[b.row - 1]?.sourceRow })),
    template: info ? { name: info.name, language: info.language, paramCount: info.paramCount } : null,
    shape,
  };
}

export type DryRunResult = {
  /** Present only when every check passed; pass it with confirmToken to startCampaign. */
  campaignId?: string;
  confirmToken?: string;
  pilotSize?: number;
  ok: boolean;
  checks: PreflightCheck[];
  summary: PreflightReport<DryRunRow>["summary"];
  blocked: (BlockedRow & { sourceRow?: number })[];
  blockedTruncated: boolean;
};

/** Screens the list and, when it passes, saves the campaign (not started) and returns its confirmation token. Sends nothing. */
export async function createDryRun(deps: CampaignDeps, input: { template: { name: string; language: string }; rows: readonly DryRunRow[]; send?: SendOptions }): Promise<DryRunResult> {
  const now = (deps.now ?? Date.now)();
  const send = cleanSend(input.send);
  const s = await screen(deps, input.template, input.rows, now, send);
  const result: DryRunResult = {
    ok: s.ok,
    checks: s.checks,
    summary: s.report.summary,
    blocked: s.blocked.slice(0, BLOCKED_SAMPLE),
    blockedTruncated: s.blocked.length > BLOCKED_SAMPLE,
  };
  if (!s.ok || !s.template) return { ...result, ok: false };

  const id = randomUUID();
  const recipients: CampaignRecipient[] = s.report.accepted.map((a) => ({
    phone: a.phone,
    params: a.params ?? [],
    ...(a.headerParam?.trim() ? { headerParam: a.headerParam.trim() } : {}),
    ...(a.buttonParam?.trim() ? { buttonParam: a.buttonParam.trim() } : {}),
    sourceRow: a.sourceRow,
    consentSource: a.consentSource!,
    consentAt: iso(a.consentAt!),
  }));
  const total = recipients.length;
  const c: Campaign = {
    id,
    createdAt: now,
    status: "dry_run",
    template: s.template,
    ...(s.shape ? { shape: s.shape } : {}),
    ...(send ? { send } : {}),
    confirmToken: randomUUID(),
    total,
    cursor: 0,
    pilotSize: Math.min(total, Math.max(PILOT_MIN, Math.ceil(total * PILOT_SHARE))),
    pilotDone: false,
    evalFrom: 0,
    skipped: 0,
    skippedBy: {},
  };
  await deps.store.mkSet(key(id, ":r"), recipients);
  await save(deps.store, c, []);
  const ids = (await deps.store.mkGet<string[]>("camp:ids")) ?? [];
  await deps.store.mkSet("camp:ids", [id, ...ids].slice(0, 50));
  return { ...result, campaignId: id, confirmToken: c.confirmToken, pilotSize: c.pilotSize };
}

export type StartResult = { ok: true; campaign: CampaignView } | { ok: false; error: string; checks?: PreflightCheck[] };

/** Starts a dry-run campaign after re-screening with current data. Sends nothing yet; call advanceCampaign next. */
export async function startCampaign(deps: CampaignDeps, id: string, token: string): Promise<StartResult> {
  const { store } = deps;
  const now = (deps.now ?? Date.now)();
  const c = await load(store, id);
  if (!c) return { ok: false, error: "Campaign not found." };
  if (c.status !== "dry_run") return { ok: false, error: `Campaign is already ${c.status}; a dry run can be started once.` };
  if (!c.confirmToken || token !== c.confirmToken) return { ok: false, error: "The confirmation token does not match this dry run." };
  if (now - c.createdAt > TOKEN_TTL_MS) return { ok: false, error: "The dry run is older than 24 hours; run it again so the checks use current data." };

  const stored = (await store.mkGet<CampaignRecipient[]>(key(id, ":r"))) ?? [];
  const s = await screen(deps, c.template, stored, now, c.send);
  if (!s.ok) return { ok: false, error: "The checks no longer pass; nothing was started.", checks: s.checks.filter((x) => !x.ok) };

  if (!(await store.mkLock("active", 14 * 24 * 60 * 60))) return { ok: false, error: "Another campaign holds the account." };
  await store.mkSet("camp:active", id);

  const accepted = new Set(s.report.accepted.map((a) => a.phone));
  const recipients = stored.filter((r) => accepted.has(r.phone));
  await store.mkSet(key(id, ":r"), recipients);
  c.total = recipients.length;
  c.pilotSize = Math.min(c.total, Math.max(PILOT_MIN, Math.ceil(c.total * PILOT_SHARE)));
  c.status = "running";
  c.startedAt = now;
  delete c.confirmToken;
  await save(store, c);
  return { ok: true, campaign: view(c, []) };
}

// -- sending -----------------------------------------------------------------

export type AdvanceOptions = {
  /** How long this call may keep sending. Default 45 s, under the 60 s function limit. */
  budgetMs?: number;
  batch?: number;
  perSecond?: number;
  pilotWaitMs?: number;
};

function halt(c: Campaign, reason: string, code?: number) {
  c.status = "halted";
  c.haltReason = reason;
  c.haltCode = code;
}

/** Sends the next slice of a started campaign. Safe to call repeatedly; a second call while one runs does nothing. */
export async function advanceCampaign(deps: CampaignDeps, id: string, opts: AdvanceOptions = {}): Promise<CampaignView> {
  const { graph, store } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const budgetMs = opts.budgetMs ?? 45_000;
  const batchSize = opts.batch ?? 25;
  const gapMs = 1000 / (opts.perSecond ?? 10);
  const breaker = deps.breaker ?? DEFAULT_BREAKER;

  const c = await load(store, id);
  if (!c) throw new Error("Campaign not found.");
  const outcomes = (await store.mkGet<Outcome[]>(key(id, ":o"))) ?? [];
  if (c.status !== "running" && c.status !== "waiting") return view(c, outcomes);
  if (c.status === "waiting" && c.resumeAt && now() < c.resumeAt) return view(c, outcomes);
  if (!(await store.mkLock(`tick:${id}`, Math.ceil(budgetMs / 1000) + 30))) return view(c, outcomes, { busy: true });

  const deadline = now() + budgetMs;
  try {
    const recipients = (await store.mkGet<CampaignRecipient[]>(key(id, ":r"))) ?? [];
    c.status = "running";
    delete c.resumeAt;
    let quality: string | undefined;

    while (c.status === "running" && c.cursor < c.total && now() < deadline) {
      const stop = await store.mkGet<"pause" | "cancel">(key(id, ":stop"));
      if (stop) {
        applyStop(c, stop);
        await store.mkSet(key(id, ":stop"), null);
        break;
      }
      await refreshStatuses(store, outcomes, STATUS_WINDOW);
      const info = await settle(() => graph.phoneInfo());
      quality = (info as any)?.quality_rating;
      const verdict = evaluate(outcomes.slice(c.evalFrom), quality, breaker);
      if (verdict.halt) {
        halt(c, verdict.reason, verdict.code);
        break;
      }

      const end = Math.min(c.cursor + batchSize, c.pilotDone ? c.total : c.pilotSize);
      const batch = recipients.slice(c.cursor, end);
      const phones = batch.map((r) => r.phone);
      const [optedOut, last] = await Promise.all([store.optedOut(phones), store.lastMarketing(phones)]);

      for (const r of batch) {
        if (now() >= deadline) break;
        // already_sent: the process died after sending but before the cursor was saved; the send was recorded
        const lastAt = last.get(r.phone);
        const skip = optedOut.has(r.phone) ? "opted_out" : lastAt !== undefined && lastAt >= (c.startedAt ?? Infinity) ? "already_sent" : null;
        if (skip) {
          c.skipped++;
          c.skippedBy[skip] = (c.skippedBy[skip] ?? 0) + 1;
          c.cursor++;
          continue;
        }

        const at = now();
        let outcome: Outcome;
        try {
          const res = await graph.sendMessage(r.phone, templateMessage(c.template, r, c.shape, c.send));
          outcome = { phone: r.phone, at, ok: true, messageId: res.messageId };
          try {
            await store.recordMarketingSend(r.phone, at);
            if (res.messageId) {
              await store.saveMessage({
                id: res.messageId,
                waId: res.waId ?? r.phone,
                direction: "out",
                type: "template",
                text: `[template ${c.template.name}] ${r.params.join(" | ")}`,
                timestamp: Math.floor(at / 1000),
                status: "sent",
                source: "api",
              });
            }
          } catch (err) {
            console.error("campaign bookkeeping failed after a send", err);
          }
        } catch (e) {
          outcome = { phone: r.phone, at, ok: false, errorCode: e instanceof GraphError ? e.code : undefined, error: e instanceof Error ? e.message : String(e) };
        }
        outcomes.push(outcome);
        c.cursor++;

        // Judged after every message, not only failures: the failure rate starts counting at minAttempts, which a success can be the one to reach.
        const v = evaluate(outcomes.slice(c.evalFrom), quality, breaker);
        if (v.halt) {
          halt(c, v.reason, v.code);
          break;
        }
        await sleep(gapMs);
      }
      await save(store, c, outcomes);

      if (c.status === "running" && !c.pilotDone && c.cursor >= c.pilotSize) {
        c.pilotDone = true;
        if (c.cursor < c.total) {
          c.status = "waiting";
          c.resumeAt = now() + (opts.pilotWaitMs ?? PILOT_WAIT_MS);
        }
      }
    }

    if (c.status === "running" && c.cursor >= c.total) {
      await refreshStatuses(store, outcomes, STATUS_WINDOW);
      c.status = "completed";
      c.finishedAt = now();
    }
    await save(store, c, outcomes);
    // The helpers above change c.status in ways the compiler's narrowing cannot follow.
    const final = c.status as CampaignStatus;
    if (final === "completed" || final === "cancelled") await release(store, id);
    return view(c, outcomes);
  } finally {
    await store.mkUnlock(`tick:${id}`);
  }
}

// -- control -----------------------------------------------------------------

function applyStop(c: Campaign, mode: "pause" | "cancel") {
  if (mode === "cancel") {
    c.status = "cancelled";
    c.finishedAt = Date.now();
  } else {
    halt(c, "Paused by a person.");
  }
}

/** Pauses or cancels a live campaign. If a slice is running it stops at its next batch. */
export async function stopCampaign(deps: CampaignDeps, id: string, mode: "pause" | "cancel"): Promise<CampaignView> {
  const { store } = deps;
  const c = await load(store, id);
  if (!c) throw new Error("Campaign not found.");
  const outcomes = (await store.mkGet<Outcome[]>(key(id, ":o"))) ?? [];
  if (!LIVE.includes(c.status) && c.status !== "dry_run") return view(c, outcomes);
  if (mode === "pause" && c.status === "halted") return view(c, outcomes); // keep the breaker's reason
  if (c.status === "dry_run") {
    if (mode === "cancel") {
      c.status = "cancelled";
      c.finishedAt = (deps.now ?? Date.now)();
      delete c.confirmToken;
      await save(store, c);
    }
    return view(c, outcomes);
  }
  await store.mkSet(key(id, ":stop"), mode);
  if (await store.mkLock(`tick:${id}`, 30)) {
    try {
      const fresh = (await load(store, id)) ?? c;
      await store.mkSet(key(id, ":stop"), null);
      if (LIVE.includes(fresh.status) && !(mode === "pause" && fresh.status === "halted")) {
        applyStop(fresh, mode);
        await save(store, fresh);
        if (fresh.status === "cancelled") await release(store, id);
      }
      return view(fresh, outcomes);
    } finally {
      await store.mkUnlock(`tick:${id}`);
    }
  }
  return view(c, outcomes, { busy: true });
}

export type ResumeResult = { ok: true; campaign: CampaignView } | { ok: false; error: string };

/** Resumes a halted campaign. The number must be GREEN again; the breaker then judges only what is sent from here on. */
export async function resumeCampaign(deps: CampaignDeps, id: string): Promise<ResumeResult> {
  const { graph, store } = deps;
  const c = await load(store, id);
  if (!c) return { ok: false, error: "Campaign not found." };
  if (c.status !== "halted") return { ok: false, error: `Campaign is ${c.status}, not halted.` };
  const info = await settle(() => graph.phoneInfo());
  const quality = (info as any)?.quality_rating;
  if (quality !== (deps.breaker ?? DEFAULT_BREAKER).requiredQuality) return { ok: false, error: `Number quality is "${quality ?? "unknown"}"; resume only when it is back to GREEN.` };
  const outcomes = (await store.mkGet<Outcome[]>(key(id, ":o"))) ?? [];
  c.status = "running";
  c.evalFrom = outcomes.length;
  delete c.haltReason;
  delete c.haltCode;
  await store.mkSet(key(id, ":stop"), null);
  await save(store, c);
  return { ok: true, campaign: view(c, outcomes) };
}

// -- reporting ---------------------------------------------------------------

const mask = (p: string) => `${p.slice(0, 5)}****${p.slice(-3)}`;

export type CampaignReport = CampaignView & {
  delivered: number;
  read: number;
  /** accepted by Meta, no delivery update yet */
  pending: number;
  failureRate: number;
  errors: { code: number | null; count: number; meaning?: string }[];
  /** phone numbers are masked */
  failureSample: { phone: string; code?: number; error?: string }[];
};

export async function campaignReport(deps: CampaignDeps, id: string): Promise<CampaignReport | null> {
  const { store } = deps;
  const c = await load(store, id);
  if (!c) return null;
  const outcomes = (await store.mkGet<Outcome[]>(key(id, ":o"))) ?? [];
  await refreshStatuses(store, outcomes);
  const accepted = outcomes.filter((o) => o.ok && o.messageId);
  const msgs = await store.messagesByIds(accepted.map((o) => o.messageId!));
  const delivered = msgs.filter((m) => m?.status === "delivered" || m?.status === "read").length;
  const read = msgs.filter((m) => m?.status === "read").length;
  const byCode = new Map<number | null, number>();
  for (const o of outcomes.filter((x) => !x.ok)) byCode.set(o.errorCode ?? null, (byCode.get(o.errorCode ?? null) ?? 0) + 1);
  return {
    ...view(c, outcomes),
    delivered,
    read,
    pending: accepted.length - delivered,
    failureRate: outcomes.length ? Number(((outcomes.length - accepted.length) / outcomes.length).toFixed(4)) : 0,
    errors: [...byCode].map(([code, count]) => ({ code, count, meaning: code ? HALT_CODES[code] : undefined })).sort((a, b) => b.count - a.count),
    failureSample: outcomes
      .filter((o) => !o.ok)
      .slice(0, 20)
      .map((o) => ({ phone: mask(o.phone), code: o.errorCode, error: o.error })),
  };
}

export async function listCampaigns(deps: CampaignDeps, limit = 20): Promise<CampaignView[]> {
  const ids = ((await deps.store.mkGet<string[]>("camp:ids")) ?? []).slice(0, limit);
  const out: CampaignView[] = [];
  for (const id of ids) {
    const c = await load(deps.store, id);
    if (c) out.push(view(c, (await deps.store.mkGet<Outcome[]>(key(id, ":o"))) ?? []));
  }
  return out;
}
