// Links in automatic replies on the official number go out as a tap-to-open button (Cloud API cta_url).

export const DEFAULT_LINK_LABEL = "افتح الرابط";

/** Told to the AI on the official number, so it names the button. */
export const LINK_RULE = `If your reply includes a link, write it once as [button label](https://...) with a short label of up to 20 characters that says what the link opens (for example: [شوف الباقات](https://...)). Use one link per reply whenever you can.`;

/** Official number: a merchant who closes the chat gets a short closing line, so it does not stay waiting on us. */
export const CLOSING_RULE = `When the merchant only closes the conversation (thanks, ok, a sticker or similar) and nothing is left to do, do not output [[SKIP]]: reply with one short, warm closing line in their dialect, for example: العفو، حاضرين لأي استفسار. Use the rating message instead when its conditions apply. This overrides any earlier rule to skip such closing messages, including the rule about a team member working with the merchant: when the merchant only closes after a team member's message (for example: بإذن الله، شكراً), still send the closing line, so the chat never ends on the merchant's side. A closing message to the team is not a personal message. Output [[SKIP]] instead of a closing line when: the last message from our side (yours or the team's) already thanks the merchant or closes the chat, or is a closing line or the rating message, so the same closing never goes twice; the merchant's message only answers thanks (عفواً، العفو، ولو، تسلم); or the merchant sends a sticker, greeting or emoji in reply to a question or request from our side that they have not answered yet, because that is not a closing. Only reply العفو when the merchant actually thanked us. When the message is an automatic reply from the merchant's own system (an away message such as "we are not available now, we will reply soon"), reply once with one short general line, for example: حياك الله، وصلتنا رسالتكم، ومتى ما احتجتوا أي مساعدة في زيادة حنا حاضرين هنا. If your own last message already answered such an automatic reply, output [[SKIP]], so two automatic systems never keep answering each other. A short yes from the merchant (تم، تمام، إيه، أوكي) that answers a question or an offer from our side (yours or the team's, for example sending تم to be added to the merchants' community group) is a request, not a closing: never output [[SKIP]] for it. Reply with one short line that confirms what happens next, without saying something is done when nobody has done it yet. For the merchants' community group, reply with exactly this line, with the link as a button: حياك الله، بيتم اضافتك لمجموعة [مجتمع التجار](https://chat.whatsapp.com/Jde0xcgYVyc0IofyjTVvJp) قريبا مع الزر تحت. Never write أبشر or any promise for something nobody on our side has confirmed. Still output [[SKIP]] for spam.`;

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
export const UNSURE_RULE = `Only answer from <knowledge>, from these instructions, or from what was already said in the conversation. If you are not sure of the answer, do not guess and do not promise anything on the team's behalf (no reports, emails, discounts, dates, groups or features that are not written there): reply with exactly this line and nothing else: ${UNSURE_LINE} If the conversation already has this line, the handover text or the working-hours line (ساعات العمل) after the merchant's last question, output [[SKIP]] instead.`;

export const GROUP_RULE = `A private WhatsApp group with our team is optional and the merchant creates it themselves with this number if they want it: we never create it and never add them. Never say the team will create it, add them or arrange it. If they ask how, tell them they can create the group and add this number. If they ask what the group is for, say it is for following the store's performance, getting ready for seasons and offers, Ziadah updates, and support. Do not add other goals.`;
/** Team hours on the official number: Sunday to Thursday, 9:00 to 17:00 Riyadh time (UTC+3, no DST). */
export const OFF_HOURS_LINE = "اكتب استفسارك بالتفصيل هنا، وأول ما يبدأ الدوام بيرد عليك الفريق، ومالك إلا اللي يرضيك. ساعات العمل من الأحد إلى الخميس، من 9 صباحًا إلى 5 مساءً.";
const HANDOVER = "جاري تحويلك للفريق المختص";

export function offHours(ms: number): boolean {
  const d = new Date(ms + 3 * 3600_000);
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day === 5 || day === 6 || h < 9 || h >= 17;
}

/** Outside team hours a reply that hands the merchant to the team says when the team is back instead. */
export function withHours(text: string, ms: number): string {
  if (!offHours(ms)) return text;
  const i = text.indexOf(HANDOVER);
  const head = i >= 0 ? text.slice(0, i).replace(/[\s،,]+$/, "") : text.trim() === UNSURE_LINE ? "" : null;
  if (head === null) return text;
  return head ? `${/[.!؟?]$/.test(head) ? head : head + "."}\n\n${OFF_HOURS_LINE}` : `حياك الله، ${OFF_HOURS_LINE}`;
}

/** Changing the account email is the merchant's own step, for security and privacy. */
export const EMAIL_RULE = `When the merchant asks to change the account email (or the email the reports go to), the team never changes it for them, for security and privacy. Reply with exactly this, adding the dashboard link as a button labelled لوحة زيادة: حياك الله، حرصًا على أمان حسابكم وخصوصية بياناتكم، تعديل الايميل يكون منكم مباشرة: ادخل لوحة زيادة، واضغط الأيقونة أعلى يسار الشاشة ← الملف الشخصي ← عدّل الايميل واحفظ. وبعدها توصلكم التقارير والتنبيهات على الايميل الجديد. ولو واجهتكم أي مشكلة في الدخول، ارسلوا لي اسم المتجر وايميل الحساب الحالي في رسالة وحدة. If the merchant then says they do not have access to the current email, reply with exactly this and do not hand over to the team: حياك الله، لدواعي الأمان والخصوصية ما نقدر نغيّر الايميل من طرفنا. يلزم عضو فريقكم اللي فعّل التطبيق يدخل لوحة زيادة بالايميل الحالي ويغيّره للايميل المطلوب من الملف الشخصي. Only if the merchant then says the team member who activated the app is no longer with the store or cannot log in, the team steps in: ask in one line for the store name and the new email, and once both are in the conversation, hand over to the team with the usual handover text.`;
/** A merchant in a chat the team is handling waits this long for the team before Zaid answers. */
export const TEAM_WAIT_SECS = 15 * 60;

/** A team member's answer from the app keeps the chat theirs for this long: each new merchant message waits TEAM_WAIT_SECS for them first. */
export const TEAM_OWNS_SECS = 24 * 3600;
/** The WhatsApp Business app's own away/greeting message, which is not a team member answering. */
const APP_AUTO = /ان لم تتلقى رد خلال 24 ساعة|كيف اساعدك اليوم/;
export const isAppAuto = (m: { direction: string; source?: string; text?: string; caption?: string }) =>
  m.direction === "out" && m.source === "business_app" && APP_AUTO.test(m.text ?? m.caption ?? "");

type Msg = { id: string; direction: "in" | "out"; type: string; text?: string; caption?: string; timestamp: number; source?: string };

/**
 * When a team member last answered the merchant from the app (unix seconds): a Business-app message
 * sent within a day after a merchant message. A broadcast that opens a chat, and the app's away message, do not count.
 */
export function teamRepliedAt(msgs: readonly Msg[]): number | undefined {
  let lastIn: number | undefined, at: number | undefined;
  for (const m of msgs) {
    if (m.type === "reaction") continue;
    if (m.direction === "in") lastIn = m.timestamp;
    else if (m.source === "business_app" && lastIn !== undefined && m.timestamp - lastIn < TEAM_OWNS_SECS && !isAppAuto(m)) at = m.timestamp;
  }
  return at;
}

/** The merchant sent another message after this one: only the newest of a burst gets a reply. */
export function newerInbound(msgs: readonly Msg[], id: string | undefined): boolean {
  const i = id ? msgs.findIndex((m) => m.id === id) : -1;
  return i >= 0 && msgs.slice(i + 1).some((m) => m.direction === "in" && m.type !== "reaction");
}

/** When a team member last wrote anything from the app (a broadcast too), leaving out the app's away message. */
export function lastTeamAt(msgs: readonly Msg[]): number | undefined {
  return msgs.filter((m) => m.direction === "out" && m.source === "business_app" && !isAppAuto(m)).pop()?.timestamp;
}

/** Someone on our side (Zaid or the team) already wrote after this message; the app's away message does not count. */
export function answeredAfter(msgs: readonly Msg[], id: string | undefined): boolean {
  const i = id ? msgs.findIndex((m) => m.id === id) : -1;
  return i >= 0 && msgs.slice(i + 1).some((m) => m.direction === "out" && m.type !== "reaction" && !isAppAuto(m));
}

/** Letters from scripts Zaid never writes (Korean, Chinese, Japanese, Cyrillic, Hebrew, Hindi, Thai): a broken model output. */
export const FOREIGN_SCRIPT = /[Ѐ-ӿ֐-׿ऀ-ॿ฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/;

/** Sensitive requests go to the team with no explanation, argument or offer from Zaid. */
export const STRICT_RULE = `Strict rules for every reply:
- When the merchant asks to cancel or unsubscribe, asks for a refund, complains about a charge, the app or the team, says something is wrong with their data, or is upset: do not explain, argue, justify or blame anyone (not Zid, not the merchant, not the team). Never say it is not our side, never say the team already explained it, never state a cancellation or refund policy, and never apologize for a mistake nobody confirmed. Reply with exactly this and nothing else: حياك الله، وصلنا طلبك، جاري تحويلك للفريق المختص
- When the merchant only asks whether numbers we sent them are real or accurate, reply with exactly this and nothing else: حياك الله، الأرقام كلها من حساب متجرك في زيادة، وتقدر تتأكد منها بنفسك بالدخول بحسابك في [لوحة زيادة](https://dashboard.ziadah.app/login) If they still doubt the numbers after that, use the handover line above.
- Never offer anything the merchant did not ask for: no review, meeting, call, explanation or "تحب أوضح لك" question at the end of a reply.
- One reply answers everything the merchant wrote since our last message. Keep it to two short sentences unless a step-by-step answer was asked for.
- Write only Arabic, or English when the merchant writes English. Never use letters from any other language.`;

/** Zaid only runs when the team is not answering (or let 15 minutes pass), so a real question always gets an answer. */
export const DIRECT_RULE = `Nobody from the team is answering this message: you are. Never output [[SKIP]] for a real question or request. When the answer is in <knowledge> or in the conversation (our own earlier messages count, for example a price or offer we already sent), answer it directly in one or two short sentences. Only when the answer is in neither, reply with the unsure line from the rules above so the team takes it.`;

/** Words that mark a chat as setting up or changing a meeting time. */
const MEETING_TALK = /اجتماع|إجتماع|ميتنق|ميتنج|موعد|مواعيد|جدولة|جدول[هة]|الساع[هة]|وقت صلا|meeting|zoom|\bmeet\b|\bcall\b/i;

const TIME_WORDS = /[0-9٠-٩]|متاح|مناسب|يناسب|وقت|اليوم|بكر[هة]|بكرا|غد[اًا]?|الصبح|الظهر|العصر|المغرب|العشاء|مساء|صباح|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|السبت|الجمعة|ألغي|الغي|أأجل|اأجل|أجل|تأجيل|تغيير|اغير|أغير/;
const bodyText = (m: Msg) => m.text ?? m.caption ?? "";

/**
 * Whether the merchant is arranging a meeting: the message or one of the few before it (within two hours)
 * talks about a meeting or a time. Zaid answers these at once even while the team is in the chat, because
 * it holds the calendar.
 */
export function meetingTalk(msgs: readonly Msg[], id: string): boolean {
  const i = msgs.findIndex((m) => m.id === id);
  if (i < 0) return false;
  const at = msgs[i].timestamp;
  // the merchant's own words must be about a time, so a "تمام شكرا" after the team set the meeting stays with the team
  if (!(MEETING_TALK.test(bodyText(msgs[i])) || TIME_WORDS.test(bodyText(msgs[i])))) return false;
  return msgs.slice(Math.max(0, i - 6), i + 1).some((m) => at - m.timestamp <= 7200 && !isAppAuto(m) && MEETING_TALK.test(bodyText(m)));
}

/** What each plan includes, from ziadah.app/pricing. Zaid may only name a feature for a plan when it is listed here. */
export const PLANS_RULE = `Plan features (the only source for what a plan includes, it overrides anything else):
- الانطلاقة: اقتراحات صفحة المنتج، عروض المنتجات، عروض الكميات، التحليلات، 60 نقطة ذكاء اصطناعي. لا تشمل: الكوبونات، الوصول للشحن المجاني.
- النمو: كل ما في الانطلاقة + اقتراحات السلة، الاقتراح بعد الإضافة وبعد الحذف، الكوبونات، عضوين للفريق، 600 نقطة. لا تشمل: الوصول للشحن المجاني، عروض الاستبدال، الاقتراح بعد الدفع، اقتراحات قيمة السلة.
- الاحترافية: كل ما في النمو + الاقتراح بعد الدفع، اقتراحات قيمة السلة، عروض الاستبدال، الوصول للشحن المجاني، تحليلات لكل منتج، دعم القالب، 6000 نقطة. لا تشمل: الصفحة الرئيسية، صفحة التصنيف، صفحة إتمام الطلب.
- الأعمال: كل ما في الاحترافية + الصفحة الرئيسية، صفحة التصنيف، صفحة إتمام الطلب، فريق غير محدود، مدير نجاح، مراجعة شهرية، دعم مخصص، 60000 نقطة.
- اشترِ أكثر ووفّر أكثر: متاحة في كل الباقات.
- الشراء معاً: في صفحة المنتج متاحة في كل الباقات، وعند حدث الإضافة للسلة من باقة النمو وأعلى.
- كل الباقات فيها تجربة 7 أيام.
Never say a plan includes a feature unless it is listed for that plan above. When asked about a feature in a plan that excludes it, say plainly it is not in their plan and name the lowest plan that has it. Never list a plan's features unless the merchant asked about them, and then only the ones they asked about. For a feature not listed above, reply with the unsure line.`;

/** A closing offer the merchant did not ask for ("تبين نراجع لك...؟"): taken off the end of a reply that says something else. */
const OFFER = /(?:^|[.!؟?\n]\s*)((?:تب[يغ]ن?|تبون|تحب(?:ين|ون)?|ودك|ودكم)\s[^.!؟?\n]*[؟?])\s*$/;
export function dropOffer(text: string): string {
  const m = OFFER.exec(text);
  if (!m || /\]\(https?:/.test(m[1])) return text;
  const head = text.slice(0, m.index + m[0].length - m[1].length).trimEnd();
  return head.replace(/[\s،,]+$/, "").length >= 10 ? head : text;
}
