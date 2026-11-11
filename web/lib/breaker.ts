// Circuit breaker for marketing campaigns: decides, from what has happened so
// far, whether the next message may be sent. A halted campaign stays halted
// until a person resumes it; nothing here retries or recovers on its own.

export type Outcome = {
  phone: string;
  /** ms */
  at: number;
  ok: boolean;
  /** Meta message id when the send was accepted. */
  messageId?: string;
  /** Meta error code, from the send itself or from a later "failed" delivery status. */
  errorCode?: number;
  error?: string;
};

/** Codes that point at the account, the template or the sending pace, not at one recipient. One is enough to stop. */
export const HALT_CODES: Record<number, string> = {
  130429: "throughput limit reached (sending too fast)",
  131048: "spam rate limit: Meta judged the messages as spam",
  131049: "Meta withheld the message to keep the ecosystem healthy (marketing frequency or low engagement)",
  131056: "too many messages to the same recipient (pair rate limit)",
  131031: "the account is locked",
  131042: "payment method problem",
  190: "the access token is invalid or expired",
  132000: "template parameter count does not match",
  132001: "template does not exist in this language",
  132005: "template text is too long after translation",
  132007: "template violates a WhatsApp policy",
  132012: "template parameter format does not match",
  132015: "template is paused",
  132016: "template is disabled",
};

export type BreakerConfig = {
  /** Halt when strictly more than this share of attempts failed. */
  maxFailureRate: number;
  /** The failure rate is ignored below this many attempts, so one early failure cannot stop a campaign. */
  minAttempts: number;
  /** Anything else than this quality rating halts. */
  requiredQuality: string;
};

export const DEFAULT_BREAKER: BreakerConfig = { maxFailureRate: 0.05, minAttempts: 20, requiredQuality: "GREEN" };

export type Verdict = { halt: false } | { halt: true; reason: string; code?: number };

/** "131048: Spam rate limit" (how updateStatus stores a failed delivery) to 131048. */
export function parseErrorCode(error: string | undefined): number | undefined {
  const m = /^(\d{3,6})\b/.exec(error ?? "");
  return m ? Number(m[1]) : undefined;
}

export function evaluate(outcomes: readonly Outcome[], quality: string | undefined, cfg: BreakerConfig = DEFAULT_BREAKER): Verdict {
  if (quality !== cfg.requiredQuality) {
    return { halt: true, reason: `Number quality rating is "${quality ?? "unknown"}", not ${cfg.requiredQuality}.` };
  }
  for (const o of outcomes) {
    const why = o.errorCode !== undefined ? HALT_CODES[o.errorCode] : undefined;
    if (why) return { halt: true, reason: `Meta error ${o.errorCode}: ${why}.`, code: o.errorCode };
  }
  const failed = outcomes.filter((o) => !o.ok).length;
  if (outcomes.length >= cfg.minAttempts && failed / outcomes.length > cfg.maxFailureRate) {
    const pct = ((failed / outcomes.length) * 100).toFixed(1);
    return { halt: true, reason: `${failed} of ${outcomes.length} messages failed (${pct}%), over the ${(cfg.maxFailureRate * 100).toFixed(0)}% limit.` };
  }
  return { halt: false };
}
