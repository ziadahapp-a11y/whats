// Pre-send checks for marketing campaigns on the official Cloud API.
//
// Everything here is a pure function: callers fetch the data (phone info from
// Meta, consent and send history from the store) and pass it in, so each rule
// is testable without network or Redis. Every check fails closed: missing or
// unrecognised data blocks the send instead of letting it through.

export type PreflightCheck = {
  id: string;
  ok: boolean;
  message: string;
};

// ---------------------------------------------------------------------------
// Account and number
// ---------------------------------------------------------------------------

/** The subset of GET /{phone-number-id} the account checks read. */
export type PhoneInfo = {
  status?: string;
  code_verification_status?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
};

/** Unique recipients per rolling 24 hours for each Meta messaging tier. */
export const TIER_LIMITS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};

export function checkAccount(info: PhoneInfo | null): PreflightCheck[] {
  if (!info) {
    return [{ id: "account.info", ok: false, message: "Could not read the number's status from Meta, so nothing is sent." }];
  }
  const checks: PreflightCheck[] = [];
  checks.push({
    id: "account.connected",
    ok: info.status === "CONNECTED",
    message: info.status === "CONNECTED" ? "Number is connected." : `Number status is "${info.status ?? "unknown"}"; it must be CONNECTED.`,
  });
  checks.push({
    id: "account.verified",
    ok: info.code_verification_status === "VERIFIED",
    message:
      info.code_verification_status === "VERIFIED"
        ? "Number is verified."
        : `Number verification is "${info.code_verification_status ?? "unknown"}"; it must be VERIFIED.`,
  });
  checks.push({
    id: "account.quality",
    ok: info.quality_rating === "GREEN",
    message:
      info.quality_rating === "GREEN"
        ? "Quality rating is GREEN."
        : `Quality rating is "${info.quality_rating ?? "unknown"}"; campaigns only run on GREEN.`,
  });
  const tier = info.messaging_limit_tier;
  checks.push({
    id: "account.tier",
    ok: !!tier && tier in TIER_LIMITS,
    message: tier && tier in TIER_LIMITS ? `Messaging limit tier is ${tier}.` : `Messaging limit tier "${tier ?? "unknown"}" is not recognised, so capacity cannot be verified.`,
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/** The subset of a message template the campaign checks read. */
export type TemplateInfo = {
  name: string;
  language: string;
  status?: string;
  category?: string;
  /** Meta's quality_score.score: GREEN, YELLOW, RED or UNKNOWN. */
  quality?: string;
  /** Number of {{n}} variables in the body. */
  paramCount: number;
};

export function checkTemplate(template: TemplateInfo | null, language: string): PreflightCheck[] {
  if (!template) return [{ id: "template.found", ok: false, message: "Template not found." }];
  return [
    {
      id: "template.approved",
      ok: template.status === "APPROVED",
      message: template.status === "APPROVED" ? "Template is approved." : `Template status is "${template.status ?? "unknown"}"; it must be APPROVED.`,
    },
    {
      id: "template.category",
      ok: template.category === "MARKETING",
      message: template.category === "MARKETING" ? "Template category is MARKETING." : `Template category is "${template.category ?? "unknown"}"; campaigns use MARKETING templates.`,
    },
    {
      id: "template.language",
      ok: template.language === language,
      message: template.language === language ? `Template language is ${language}.` : `Template language is "${template.language}" but the campaign uses "${language}".`,
    },
    {
      id: "template.quality",
      ok: template.quality !== "RED",
      message: template.quality === "RED" ? "Template quality is RED; Meta may pause it." : "Template quality is acceptable.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))).replace(/[۰-۹]/g, (d) => String(EXTENDED_ARABIC_INDIC.indexOf(d)));
}

/**
 * Turns a Saudi mobile number in any common spelling (05xxxxxxxx, 5xxxxxxxx,
 * +9665xxxxxxxx, 009665xxxxxxxx, Arabic digits, an Excel float like 9665xxxxxxxx.0) into
 * "9665xxxxxxxx", or null when it is not a Saudi mobile.
 */
export function normalizeSaudiMobile(input: unknown): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  let s = toAsciiDigits(String(input)).trim().replace(/\.0+$/, "");
  s = s.replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d+$/.test(s)) return null;
  if (s.startsWith("00")) s = s.slice(2);
  if (s.startsWith("966")) s = s.slice(3);
  if (s.startsWith("0")) s = s.slice(1);
  return /^5\d{8}$/.test(s) ? `966${s}` : null;
}

export type RecipientRow = {
  phone: unknown;
  /** Where the person agreed to receive messages, e.g. "dashboard". */
  consentSource?: string;
  /** When they agreed: a Date, or an ISO string (YYYY-MM-DD…). Other formats are ambiguous and rejected. */
  consentAt?: Date | string;
  /** Values for the template's {{1}}, {{2}}… in order. */
  params?: string[];
};

export type BlockReason =
  | "invalid_phone"
  | "duplicate"
  | "no_consent_source"
  | "no_consent_date"
  | "invalid_consent_date"
  | "future_consent_date"
  | "opted_out"
  | "cooldown"
  | "missing_param"
  | "bad_param";

export type BlockedRow = {
  /** 1-based position in the input. */
  row: number;
  phone: string | null;
  reason: BlockReason;
  detail: string;
};

export type RecipientContext = {
  now: number;
  /** Normalised numbers that opted out or blocked the business. */
  optedOut: ReadonlySet<string>;
  /** Normalised number to the time (ms) of the last marketing message sent to it. */
  lastMarketingAt: ReadonlyMap<string, number>;
  /** Minimum gap between two marketing messages to the same number. Default 7 days. */
  cooldownMs?: number;
  /** How many variables the template body has; every row must supply exactly this many. */
  paramCount: number;
};

export const DEFAULT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Meta rejects a template parameter that has a newline, a tab or a run of spaces.
const BAD_PARAM = /[\r\n\t]| {4,}/;

function parseConsentDate(value: Date | string | undefined): { at: Date } | { reason: "no_consent_date" | "invalid_consent_date"; detail: string } {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return { reason: "no_consent_date", detail: "Missing consent date." };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { reason: "invalid_consent_date", detail: "Consent date is not a valid date." } : { at: value };
  }
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return { reason: "invalid_consent_date", detail: `Consent date "${text}" must be ISO (YYYY-MM-DD); other formats are ambiguous.` };
  }
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? { reason: "invalid_consent_date", detail: `Consent date "${text}" is not a valid date.` } : { at };
}

export type ScreenResult<T extends RecipientRow> = {
  accepted: (T & { phone: string })[];
  blocked: BlockedRow[];
};

/** Splits rows into sendable and blocked, with one reason per blocked row (first rule that fails). */
export function screenRecipients<T extends RecipientRow>(rows: readonly T[], ctx: RecipientContext): ScreenResult<T> {
  const cooldown = ctx.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const seen = new Set<string>();
  const accepted: (T & { phone: string })[] = [];
  const blocked: BlockedRow[] = [];

  rows.forEach((r, i) => {
    const row = i + 1;
    const block = (phone: string | null, reason: BlockReason, detail: string) => blocked.push({ row, phone, reason, detail });

    const phone = normalizeSaudiMobile(r.phone);
    if (!phone) return block(null, "invalid_phone", `"${String(r.phone ?? "")}" is not a Saudi mobile number (expected 05xxxxxxxx or 9665xxxxxxxx).`);
    if (seen.has(phone)) return block(phone, "duplicate", "Number already appears earlier in the file.");
    seen.add(phone);

    if (!r.consentSource || r.consentSource.trim() === "") return block(phone, "no_consent_source", "Missing consent source.");
    const consent = parseConsentDate(r.consentAt);
    if ("reason" in consent) return block(phone, consent.reason, consent.detail);
    if (consent.at.getTime() > ctx.now) return block(phone, "future_consent_date", "Consent date is in the future.");

    if (ctx.optedOut.has(phone)) return block(phone, "opted_out", "Number opted out or blocked the business.");
    const last = ctx.lastMarketingAt.get(phone);
    if (last !== undefined && ctx.now - last < cooldown) {
      const days = Math.ceil((cooldown - (ctx.now - last)) / 86_400_000);
      return block(phone, "cooldown", `Received a marketing message recently; eligible again in ${days} day(s).`);
    }

    const params = r.params ?? [];
    if (params.length !== ctx.paramCount || params.some((p) => typeof p !== "string" || p.trim() === "")) {
      return block(phone, "missing_param", `Template needs ${ctx.paramCount} non-empty value(s), got ${params.length}.`);
    }
    if (params.some((p) => BAD_PARAM.test(p))) {
      return block(phone, "bad_param", "A value contains a newline, tab or 4+ consecutive spaces, which Meta rejects.");
    }

    accepted.push({ ...r, phone });
  });

  return { accepted, blocked };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export type Capacity = { check: PreflightCheck; limit: number; remaining: number; newUnique: number };

/**
 * Meta caps unique recipients per rolling 24 hours but exposes no "remaining"
 * figure, so we count what this system sent. Messages sent from elsewhere
 * (WhatsApp Manager, other tools) are invisible to us, hence the safety margin.
 */
export function checkCapacity(tier: string | undefined, recent24h: ReadonlySet<string>, phones: readonly string[], margin = 0.2): Capacity {
  const tierLimit = tier ? TIER_LIMITS[tier] : undefined;
  const newUnique = phones.filter((p) => !recent24h.has(p)).length;
  if (tierLimit === undefined) {
    return { check: { id: "capacity", ok: false, message: "Messaging limit unknown, so capacity cannot be verified." }, limit: 0, remaining: 0, newUnique };
  }
  const limit = Math.floor(tierLimit * (1 - margin));
  const remaining = Math.max(0, limit - recent24h.size);
  const ok = newUnique <= remaining;
  return {
    check: {
      id: "capacity",
      ok,
      message: ok
        ? `${newUnique} new recipient(s) fit in the remaining ${remaining} of ${limit} (tier ${tier}, ${Math.round(margin * 100)}% margin kept).`
        : `${newUnique} new recipient(s) exceed the remaining ${remaining} of ${limit} for the next 24 hours (tier ${tier}, ${Math.round(margin * 100)}% margin kept).`,
    },
    limit,
    remaining,
    newUnique,
  };
}

// ---------------------------------------------------------------------------
// Combined report
// ---------------------------------------------------------------------------

export type PreflightInput<T extends RecipientRow> = {
  phone: PhoneInfo | null;
  template: TemplateInfo | null;
  language: string;
  rows: readonly T[];
  now: number;
  optedOut: ReadonlySet<string>;
  lastMarketingAt: ReadonlyMap<string, number>;
  /** Normalised numbers this system already messaged in the last 24 hours. */
  recent24h: ReadonlySet<string>;
  cooldownMs?: number;
  capacityMargin?: number;
};

export type PreflightReport<T extends RecipientRow> = {
  /** True only when every account, template and capacity check passed and at least one row can be sent. */
  ok: boolean;
  checks: PreflightCheck[];
  accepted: (T & { phone: string })[];
  blocked: BlockedRow[];
  summary: { total: number; accepted: number; blocked: number; byReason: Partial<Record<BlockReason, number>>; newUnique: number; remainingCapacity: number };
};

export function preflight<T extends RecipientRow>(input: PreflightInput<T>): PreflightReport<T> {
  const account = checkAccount(input.phone);
  const template = checkTemplate(input.template, input.language);
  const { accepted, blocked } = screenRecipients(input.rows, {
    now: input.now,
    optedOut: input.optedOut,
    lastMarketingAt: input.lastMarketingAt,
    cooldownMs: input.cooldownMs,
    paramCount: input.template?.paramCount ?? 0,
  });
  const capacity = checkCapacity(
    input.phone?.messaging_limit_tier,
    input.recent24h,
    accepted.map((a) => a.phone),
    input.capacityMargin,
  );

  const checks = [...account, ...template, capacity.check];
  const byReason: Partial<Record<BlockReason, number>> = {};
  for (const b of blocked) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;

  return {
    ok: checks.every((c) => c.ok) && accepted.length > 0,
    checks,
    accepted,
    blocked,
    summary: { total: input.rows.length, accepted: accepted.length, blocked: blocked.length, byReason, newUnique: capacity.newUnique, remainingCapacity: capacity.remaining },
  };
}
