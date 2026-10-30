// Links in automatic replies on the official number go out as a tap-to-open button (Cloud API cta_url).

export const DEFAULT_LINK_LABEL = "افتح الرابط";

/** Told to the AI on the official number, so it names the button. */
export const LINK_RULE = `If your reply includes a link, write it once as [button label](https://...) with a short label of up to 20 characters that says what the link opens (for example: [شوف الباقات](https://...)). Use one link per reply whenever you can.`;

/** Official number: a merchant who closes the chat gets a short closing line, so it does not stay waiting on us. */
export const CLOSING_RULE = `When the merchant only closes the conversation (thanks, ok, a sticker or similar) and nothing is left to do, do not output [[SKIP]]: reply with one short, warm closing line in their dialect, for example: العفو، حاضرين لأي استفسار. Use the rating message instead when its conditions apply. This overrides any earlier rule to skip such closing messages, including the rule about a team member working with the merchant: when the merchant only closes after a team member's message (for example: بإذن الله، شكراً), still send the closing line, so the chat never ends on the merchant's side. A closing message to the team is not a personal message. If your own last message was already a closing line or the rating message, output [[SKIP]] so the chat ends there. When the message is an automatic reply from the merchant's own system (an away message such as "we are not available now, we will reply soon"), reply once with one short general line, for example: حياك الله، وصلتنا رسالتكم، ومتى ما احتجتوا أي مساعدة في زيادة حنا حاضرين هنا. If your own last message already answered such an automatic reply, output [[SKIP]], so two automatic systems never keep answering each other. A short yes from the merchant (تم، تمام، إيه، أوكي) that answers a question or an offer from our side (yours or the team's, for example sending تم to be added to the merchants' community group) is a request, not a closing: never output [[SKIP]] for it. Reply with one short line that confirms what happens next, without saying something is done when nobody has done it yet. For the merchants' community group, the merchant joins it from its link, nobody adds them: reply with one short line and the link as a button, exactly: حياك الله، تقدر تنضم بنفسك لمجموعة [مجتمع التجار](https://chat.whatsapp.com/Jde0xcgYVyc0IofyjTVvJp) من الزر تحت. Never write أبشر or any promise for something nobody on our side has confirmed. Still output [[SKIP]] for spam, and when a team member is handling the chat and the merchant's message is a question or request the team member should answer.`;

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

/** Official number: Zaid never guesses. A reply it is not sure of becomes a short "the team will review it". */
export const UNSURE_LINE = "حياك الله، بيراجع الفريق طلبك ويرد عليك هنا قريب بإذن الله.";
export const UNSURE_RULE = `Only answer from <knowledge>, from these instructions, or from what was already said in the conversation. If you are not sure of the answer, do not guess and do not promise anything on the team's behalf (no reports, emails, discounts, dates, groups or features that are not written there): reply with exactly this line and nothing else: ${UNSURE_LINE} If the conversation already has this line or the handover text after the merchant's last question, output [[SKIP]] instead.`;

/** A team member wrote from the app within this many seconds: Zaid does not answer at all. */
export const GROUP_RULE = `A private WhatsApp group with our team is optional and the merchant creates it themselves with this number if they want it: we never create it and never add them. Never say the team will create it, add them or arrange it. If they ask how, tell them they can create the group and add this number. If they ask what the group is for, say it is for following the store's performance, getting ready for seasons and offers, Ziadah updates, and support. Do not add other goals.`;
export const TEAM_QUIET_SECS = 15 * 60;
/** ... and within this many, Zaid only closes or skips. */
export const TEAM_ACTIVE_SECS = 30 * 60;
export const TEAM_RULE = `Lines marked "Team" were typed by a team member in the WhatsApp Business app, and that person is handling this conversation now. Output exactly [[SKIP]], unless the merchant's latest message only closes the conversation (thanks, ok, a sticker), in which case send the one short closing line.`;
