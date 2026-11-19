// Renders an approved template as the plain text the recipient sees, for the inbox.
// The send payload carries only the name and parameters, so without this the
// inbox would show "[template name]" instead of the message.

/** Fills {{n}} with values[n-1]; a missing value leaves the placeholder as is. */
function fill(text: string, values: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (m, n) => values[Number(n) - 1] ?? m);
}

/**
 * Header, body, footer and button labels of a template's components, with body
 * (and text-header) variables filled in. Returns null when there is no body, so
 * callers can fall back to the old "[template name]" text.
 */
export function renderTemplateText(components: readonly any[] | undefined, bodyParams: readonly string[] = [], headerParams: readonly string[] = []): string | null {
  const comps = components ?? [];
  const body = comps.find((c) => c?.type === "BODY");
  if (!body?.text) return null;
  const parts: string[] = [];
  const header = comps.find((c) => c?.type === "HEADER");
  if (header?.format === "TEXT" && header.text) parts.push(`*${fill(header.text, headerParams)}*`);
  else if (header?.format) parts.push(`[${String(header.format).toLowerCase()}]`);
  parts.push(fill(body.text, bodyParams));
  const footer = comps.find((c) => c?.type === "FOOTER");
  if (footer?.text) parts.push(`_${footer.text}_`);
  const buttons = (comps.find((c) => c?.type === "BUTTONS")?.buttons ?? []).map((b: any) => b?.text).filter(Boolean);
  if (buttons.length) parts.push(buttons.map((t: string) => `[${t}]`).join(" "));
  return parts.join("\n\n");
}
