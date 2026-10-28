// Turns a marketing template drafted in the dashboard into the payload Meta's
// POST /{waba-id}/message_templates expects, after checking it against the
// rejection causes Meta documents.
//
// This lowers the chance of a rejection; it cannot guarantee approval, which
// is Meta's decision (it may also re-categorise a template). Rules marked
// "heuristic" are not published thresholds. Pure functions, no network.

export type TemplateIssue = {
  level: "error" | "warning";
  /** Which part of the draft: "name", "body", "buttons[1].url", ... */
  field: string;
  message: string;
};

export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; /** Full sample URL; required when the url ends with {{1}}. */ urlExample?: string }
  | { type: "PHONE_NUMBER"; text: string; phone: string };

export type DraftHeader =
  | { type: "TEXT"; text: string }
  | { type: "IMAGE" | "VIDEO" | "DOCUMENT"; /** Handle from Meta's resumable upload API. */ handle: string };

export type TemplateDraft = {
  name: string;
  /** Meta language code, e.g. "ar". */
  language: string;
  header?: DraftHeader;
  /** Positional variables {{1}}, {{2}}… */
  body: string;
  /** One sample value per variable, in order. Meta requires them. */
  bodyExamples?: string[];
  footer?: string;
  buttons?: DraftButton[];
};

const LIMITS = { name: 512, body: 1024, header: 60, footer: 60, button: 25, url: 2000, buttons: 10, urlButtons: 2, phoneButtons: 1 };

const VAR = /\{\{([1-9]\d*)\}\}/g;
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "rb.gy", "tiny.cc"];
const SHORTENER_RE = new RegExp(`(?<![a-z0-9.-])(?:${SHORTENERS.map((s) => s.replace(/\./g, "\\.")).join("|")})(?![a-z0-9-])`, "i");
// Same rule Meta applies to variable values: no newline, tab or run of spaces.
const BAD_VALUE = /[\r\n\t]| {4,}/;

const len = (s: string) => [...s].length;

/** Lowercase letters, digits and underscores only, as Meta requires. Returns "" when nothing usable remains. */
export function normalizeTemplateName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, LIMITS.name);
}

function variableIds(text: string): number[] {
  return [...text.matchAll(VAR)].map((m) => Number(m[1]));
}

function arabicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(/\p{Script=Arabic}/gu)?.length ?? 0) / letters;
}

export function lintTemplate(draft: TemplateDraft): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const error = (field: string, message: string) => issues.push({ level: "error", field, message });
  const warn = (field: string, message: string) => issues.push({ level: "warning", field, message });

  // name and language
  if (draft.name === "") {
    error("name", "Name has no usable characters; use English letters, digits or underscores.");
  } else if (!/^[a-z0-9_]+$/.test(draft.name) || len(draft.name) > LIMITS.name) {
    error("name", "Name must be lowercase letters, digits and underscores only (max 512).");
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(draft.language)) {
    error("language", `"${draft.language}" is not a Meta language code (e.g. "ar", "en", "en_US").`);
  }

  // body
  const body = draft.body.trim();
  if (body === "") error("body", "Body is required.");
  if (len(body) > LIMITS.body) error("body", `Body is ${len(body)} characters; the limit is ${LIMITS.body}.`);

  const stripped = body.replace(VAR, "");
  if (/\{\{|\}\}/.test(stripped)) {
    error("body", "Variables must be written {{1}}, {{2}}… with no spaces or names; found a malformed {{ or }}.");
  }

  const ids = variableIds(body);
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.some((id, i) => id !== i + 1)) error("body", `Variables must be numbered 1..n without gaps; found ${unique.map((n) => `{{${n}}}`).join(", ")}.`);
  if (ids.length !== unique.length) warn("body", "A variable appears more than once; use each one once.");

  if (/^\{\{\d+\}\}/.test(body)) error("body", "Body cannot start with a variable; put text before it.");
  if (/\{\{\d+\}\}$/.test(body)) error("body", "Body cannot end with a variable; put text after it.");
  if (/\}\}\{\{/.test(body)) error("body", "Two variables cannot be adjacent; put text between them.");
  else if (/\}\}\s+\{\{/.test(body)) warn("body", "Two variables are separated only by whitespace; Meta may reject this.");

  // heuristic: Meta rejects templates with too many variables for their length, threshold unpublished
  if (unique.length > 0) {
    const perVar = len(stripped.trim()) / unique.length;
    if (perVar < 12) error("body", `Too many variables for the text length (${Math.round(perVar)} characters of text per variable); add text or remove variables.`);
    else if (perVar < 25) warn("body", `Few characters of text per variable (${Math.round(perVar)}); Meta may flag this as too variable-heavy.`);
  }

  // language must match the text
  if (body !== "") {
    const ratio = arabicRatio(stripped);
    if (draft.language === "ar" && ratio < 0.3) error("language", 'Language is "ar" but the body is mostly not Arabic; Meta rejects mismatches.');
    if (draft.language !== "ar" && ratio > 0.5) error("language", `Language is "${draft.language}" but the body is mostly Arabic; Meta rejects mismatches.`);
  }

  // examples
  const examples = draft.bodyExamples ?? [];
  if (unique.length > 0) {
    if (examples.length !== unique.length) error("bodyExamples", `Provide ${unique.length} example value(s), one per variable; got ${examples.length}.`);
    examples.forEach((ex, i) => {
      if (typeof ex !== "string" || ex.trim() === "") error(`bodyExamples[${i}]`, "Example value is empty.");
      else if (BAD_VALUE.test(ex)) error(`bodyExamples[${i}]`, "Example contains a newline, tab or 4+ consecutive spaces.");
    });
  } else if (examples.length > 0) {
    warn("bodyExamples", "Examples were given but the body has no variables; they are ignored.");
  }

  // header
  const h = draft.header;
  if (h?.type === "TEXT") {
    if (h.text.trim() === "") error("header", "Header text is empty.");
    if (len(h.text) > LIMITS.header) error("header", `Header is ${len(h.text)} characters; the limit is ${LIMITS.header}.`);
    if (/\{\{|\}\}/.test(h.text)) error("header", "Header variables are not supported here; keep the header plain text.");
    if (/[\r\n*_~]/.test(h.text)) error("header", "Header cannot contain newlines or formatting characters (* _ ~).");
    if (/\p{Extended_Pictographic}/u.test(h.text)) error("header", "Header cannot contain emoji.");
  } else if (h && (!h.handle || h.handle.trim() === "")) {
    error("header", `A ${h.type} header needs an uploaded media handle.`);
  }

  // footer
  if (draft.footer !== undefined) {
    if (draft.footer.trim() === "") error("footer", "Footer is empty; remove it or add text.");
    if (len(draft.footer) > LIMITS.footer) error("footer", `Footer is ${len(draft.footer)} characters; the limit is ${LIMITS.footer}.`);
    if (/\{\{|\}\}/.test(draft.footer)) error("footer", "Footer cannot contain variables.");
  }

  // buttons
  const buttons = draft.buttons ?? [];
  if (buttons.length > LIMITS.buttons) error("buttons", `At most ${LIMITS.buttons} buttons; got ${buttons.length}.`);
  if (buttons.filter((b) => b.type === "URL").length > LIMITS.urlButtons) error("buttons", `At most ${LIMITS.urlButtons} URL buttons.`);
  if (buttons.filter((b) => b.type === "PHONE_NUMBER").length > LIMITS.phoneButtons) error("buttons", `At most ${LIMITS.phoneButtons} phone button.`);
  const seenText = new Set<string>();
  buttons.forEach((b, i) => {
    const f = `buttons[${i}]`;
    const text = b.text.trim();
    if (text === "") error(`${f}.text`, "Button text is empty.");
    if (len(text) > LIMITS.button) error(`${f}.text`, `Button text is ${len(text)} characters; the limit is ${LIMITS.button}.`);
    if (/\{\{|\}\}/.test(text)) error(`${f}.text`, "Button text cannot contain variables.");
    if (seenText.has(text)) error(`${f}.text`, "Two buttons have the same text.");
    seenText.add(text);

    if (b.type === "URL") {
      const dynamic = /\{\{1\}\}$/.test(b.url);
      if (/\{\{|\}\}/.test(b.url.replace(/\{\{1\}\}$/, ""))) error(`${f}.url`, "Only one variable, {{1}}, is allowed and only at the very end of the URL.");
      let parsed: URL | null = null;
      try {
        parsed = new URL(b.url.replace(/\{\{1\}\}$/, "x"));
      } catch {
        error(`${f}.url`, `"${b.url}" is not a valid URL.`);
      }
      if (parsed && parsed.protocol !== "https:") error(`${f}.url`, "URL must start with https://.");
      if (len(b.url) > LIMITS.url) error(`${f}.url`, `URL is longer than ${LIMITS.url} characters.`);
      if (dynamic && (!b.urlExample || b.urlExample.trim() === "")) error(`${f}.urlExample`, "A URL ending in {{1}} needs a full sample URL.");
      if (SHORTENER_RE.test(b.url)) error(`${f}.url`, "URL shorteners are not allowed; use the full domain.");
    }
    if (b.type === "PHONE_NUMBER" && !/^\+\d{7,15}$/.test(b.phone)) {
      error(`${f}.phone`, `"${b.phone}" must be international format with +, e.g. +966501234567.`);
    }
  });

  // shorteners anywhere in the visible text
  for (const [field, text] of [["body", body], ["footer", draft.footer ?? ""], ["header", h?.type === "TEXT" ? h.text : ""]] as const) {
    if (SHORTENER_RE.test(text)) error(field, "URL shorteners are not allowed; use the full domain.");
  }

  // marketing recipients can opt out; a visible way to do it lowers block and report rates
  if (!buttons.some((b) => b.type === "QUICK_REPLY")) {
    warn("buttons", 'No quick-reply opt-out button (e.g. "إيقاف"); recommended for marketing to keep block and report rates down.');
  }

  return issues;
}

export type CompileResult =
  | { ok: true; payload: Record<string, unknown>; paramCount: number; warnings: TemplateIssue[] }
  | { ok: false; issues: TemplateIssue[] };

/** Lints the draft and, when no error remains, returns the body for POST /{waba-id}/message_templates. */
export function compileTemplate(input: TemplateDraft): CompileResult {
  const name = normalizeTemplateName(input.name);
  const draft: TemplateDraft = { ...input, name, body: input.body.trim() };
  const issues = lintTemplate(draft);
  if (name !== "" && name !== input.name) issues.unshift({ level: "warning", field: "name", message: `Name normalised to "${name}".` });

  if (issues.some((i) => i.level === "error")) return { ok: false, issues };

  const paramCount = new Set(variableIds(draft.body)).size;
  const components: Record<string, unknown>[] = [];

  const h = draft.header;
  if (h?.type === "TEXT") components.push({ type: "HEADER", format: "TEXT", text: h.text.trim() });
  else if (h) components.push({ type: "HEADER", format: h.type, example: { header_handle: [h.handle] } });

  components.push({
    type: "BODY",
    text: draft.body,
    ...(paramCount > 0 ? { example: { body_text: [draft.bodyExamples ?? []] } } : {}),
  });

  if (draft.footer !== undefined) components.push({ type: "FOOTER", text: draft.footer.trim() });

  // Meta wants buttons of the same kind grouped: quick replies, then URL, then phone.
  const order = { QUICK_REPLY: 0, URL: 1, PHONE_NUMBER: 2 } as const;
  const buttons = [...(draft.buttons ?? [])].sort((a, b) => order[a.type] - order[b.type]);
  if (buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: buttons.map((b) => {
        const text = b.text.trim();
        if (b.type === "QUICK_REPLY") return { type: "QUICK_REPLY", text };
        if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text, phone_number: b.phone };
        return { type: "URL", text, url: b.url, ...(/\{\{1\}\}$/.test(b.url) ? { example: [b.urlExample] } : {}) };
      }),
    });
  }

  return {
    ok: true,
    payload: { name, language: draft.language, category: "MARKETING", components },
    paramCount,
    warnings: issues,
  };
}
