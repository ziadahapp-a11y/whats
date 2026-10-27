// Flows as files: export one flow (or all) to JSON, import them back.
// An imported file is untrusted input, so it can never switch a flow on, send without approval or pick a number.

import { FlowInput, type Flow, type FlowDraft } from "./types";

export const FORMAT = "whats-mcp-flow";
export const VERSION = 1;
export const MAX_FILE_BYTES = 300_000;
export const MAX_FLOWS_PER_FILE = 20;

/** What travels in a file: the logic and the safety limits, nothing tied to this deployment. */
export type PortableFlow = Omit<FlowDraft, "id" | "enabled" | "account">;

export type PortableFile = {
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  flows: PortableFlow[];
};

type Header = Record<string, string>;

/** Header values can hold tokens, so they are blanked; the names stay as a reminder of what to fill in. */
function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "headers" && v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Header).map((h) => [h, ""])) : stripSecrets(v)])) as T;
  }
  return value;
}

export function exportFlows(flows: (Flow | FlowDraft)[], now = new Date()): PortableFile {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    flows: flows.map((f) => {
      const { name, trigger, match, conditions, actions, graph, mode, maxAgeMinutes, cooldownSeconds, maxPerHour, stopOnMatch, tz } = f;
      return stripSecrets({ name, trigger, match, conditions, actions, graph, mode, maxAgeMinutes, cooldownSeconds, maxPerHour, stopOnMatch, tz });
    }),
  };
}

export type Imported = { flows: FlowDraft[]; warnings: string[] };

/** Throws an Error with a message fit to show the user. */
export function parseImport(text: string): Imported {
  if (text.length > MAX_FILE_BYTES) throw new Error("الملف كبير (الحد 300KB).");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("هذا مو ملف JSON صالح.");
  }
  const file = raw as Partial<PortableFile> | null;
  if (!file || file.format !== FORMAT) throw new Error("هذا مو ملف فلو من هذي اللوحة (الصيغة غير معروفة).");
  if (file.version !== VERSION) throw new Error(`نسخة الملف (${String(file.version)}) غير مدعومة، المدعومة: ${VERSION}.`);
  if (!Array.isArray(file.flows) || file.flows.length === 0) throw new Error("الملف ما فيه فلوات.");
  if (file.flows.length > MAX_FLOWS_PER_FILE) throw new Error(`الملف فيه فلوات أكثر من ${MAX_FLOWS_PER_FILE}.`);

  const warnings = new Set<string>();
  const flows = file.flows.map((f, i) => {
    const forced = { ...(f as object), id: undefined, enabled: false, account: "*", mode: "approve" as const };
    const parsed = FlowInput.safeParse(forced);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`الفلو رقم ${i + 1} غير صالح: ${issue.path.join(".") || "flow"} ${issue.message}`);
    }
    const d = parsed.data;
    const steps = [...d.actions, ...(d.graph?.nodes.flatMap((n) => (n.kind === "action" ? [n.action] : [])) ?? [])];
    if (steps.some((a) => a.type === "webhook" && Object.keys(a.headers).length)) warnings.add("فيه Webhook بترويسات (headers) قيمها فاضية، عبّيها من جديد.");
    if (steps.some((a) => a.type === "agent" && a.connectors.length)) warnings.add("فيه خطوة مساعد بالأدوات تسمّي موصلات (MCP)، تأكد إنها موجودة عندك بنفس الأسماء.");
    if (steps.some((a) => a.type === "ai" || a.type === "ai_reply" || a.type === "agent")) warnings.add("فيه خطوات ذكاء اصطناعي، تحتاج مزود مفعّل عندك.");
    if (steps.some((a) => a.type === "send")) warnings.add("فيه خطوة إرسال لرقم محدد، راجع المستلم.");
    return d; // the validated copy: unknown keys from the file are already dropped
  });
  warnings.add("كل فلو مستورد يدخل متوقفاً بوضع مسودة وعلى كل الأرقام. راجعه وجرّبه قبل ما تفعّله.");
  return { flows, warnings: [...warnings] };
}
