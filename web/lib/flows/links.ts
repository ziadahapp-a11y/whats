// Links in automatic replies on the official number go out as a tap-to-open button (Cloud API cta_url).

export const DEFAULT_LINK_LABEL = "افتح الرابط";

/** Told to the AI on the official number, so it names the button. */
export const LINK_RULE = `If your reply includes a link, write it once as [button label](https://...) with a short label of up to 20 characters that says what the link opens (for example: [شوف الباقات](https://...)). Use one link per reply whenever you can.`;

export type LinkButton = { body: string; label: string; url: string };

const MD = /\[([^\]\n]{1,60})\]\((https:\/\/[^\s)]+)\)/;
const BARE = /https:\/\/[^\s<>()\[\]]+[^\s<>()\[\].,!?؟،:;"']/;

const tidy = (s: string) =>
  s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]*[.,!?؟،:;]+[ \t]*$/gm, "")
    .trim()
    .replace(/[ \t]*[:：]$/, "")
    .trim();

/**
 * The first https link becomes the button; a [label](url) link keeps its label as text in the body,
 * a bare link is taken out. Any other links stay as text. Null when there is no usable link.
 */
export function linkButton(text: string): LinkButton | null {
  const md = MD.exec(text);
  const bare = BARE.exec(text);
  const useMd = md && (!bare || md.index <= bare.index);
  let url: string, label: string, body: string;
  if (useMd) {
    url = md[2];
    label = md[1].trim();
    body = text.slice(0, md.index) + label + text.slice(md.index + md[0].length);
  } else if (bare) {
    url = bare[0];
    label = DEFAULT_LINK_LABEL;
    body = text.slice(0, bare.index) + text.slice(bare.index + bare[0].length);
  } else return null;
  // Other [label](url) links stay readable as "label: url".
  body = tidy(body.replace(new RegExp(MD.source, "g"), (_m, l, u) => `${l}: ${u}`));
  if (!body) body = label;
  if (label.length > 20) label = DEFAULT_LINK_LABEL;
  if (url.length > 2000 || body.length > 1024) return null;
  return { body, label, url };
}

/** The same reply as plain text, when no button can be sent. */
export const plainLinks = (text: string) => text.replace(new RegExp(MD.source, "g"), (_m, l, u) => `${l}: ${u}`);

/** The Cloud API payload for one link button. */
export const ctaPayload = (b: LinkButton) => ({
  type: "interactive",
  interactive: { type: "cta_url", body: { text: b.body }, action: { name: "cta_url", parameters: { display_text: b.label, url: b.url } } },
});
