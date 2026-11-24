// Links in automatic replies on the official number go out as a tap-to-open button (Cloud API cta_url).

export const DEFAULT_LINK_LABEL = "افتح الرابط";

/** Told to the AI on the official number, so it names the button. */
export const LINK_RULE = `If your reply includes a link, write it once as [button label](https://...) with a short label of up to 20 characters that says what the link opens (for example: [شوف الباقات](https://...)). Use one link per reply whenever you can.`;

/** Official number: a merchant who closes the chat gets a short closing line, so it does not stay waiting on us. */
export const CLOSING_RULE = `When the merchant only closes the conversation and nothing is left to do, do not output [[SKIP]] only if the closing is a real farewell after a complete answer: reply with one short, warm closing line in their dialect, for example: العفو، حاضرين لأي استفسار. Use the rating message instead when its conditions apply. A closing message to the team is not a personal message. Output [[SKIP]] instead of a closing line when: the merchant's message is only thanks or an acknowledgement (شكراً، تمام شكراً، تمام، أوكي، ok, عفواً، العفو، ولو، تسلم), whether or not a team member wrote last; the last message from our side (yours or the team's) already thanks the merchant or closes the chat, or is a closing line or the rating message, so the same closing never goes twice; or the merchant sends a sticker, greeting or emoji in reply to a question or request from our side that they have not answered yet, because that is not a closing. Never reply العفو to an acknowledgement; reply only when the merchant clearly thanks us for a finished answer and our side has not already closed. When the message is an automatic reply from the merchant's own system (an away message such as "we are not available now, we will reply soon"), reply once with one short general line, for example: حياك الله، وصلتنا رسالتكم، ومتى ما احتجتوا أي مساعدة في زيادة حنا حاضرين هنا. If your own last message already answered such an automatic reply, output [[SKIP]], so two automatic systems never keep answering each other. A short yes from the merchant (تم، تمام، إيه، أوكي) that answers a question or an offer from our side (yours or the team's, for example sending تم to be added to the merchants' community group) is a request, not a closing: never output [[SKIP]] for it. Reply with one short line that confirms what happens next, without saying something is done when nobody has done it yet. For the merchants' community group, reply with exactly this line, with the link as a button: حياك الله، بيتم اضافتك لمجموعة [مجتمع التجار](https://chat.whatsapp.com/Jde0xcgYVyc0IofyjTVvJp) قريبا مع الزر تحت. Never write أبشر or any promise for something nobody on our side has confirmed. Still output [[SKIP]] for spam.`;

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
export const ctaPayload = (b: LinkButton, image?: string) => ({
  type: "interactive",
  interactive: { type: "cta_url", ...(image ? { header: { type: "image", image: { link: image } } } : {}), body: { text: b.body }, action: { name: "cta_url", parameters: { display_text: b.label, url: b.url } } },
});

/** The support-ticket reply carries a picture of where the help button is in the dashboard. */
export const TICKET_IMAGE_PATH = "/help/ticket.png";
export const ticketImage = (text: string, base: string) => (base && /ارفع تذكرة/.test(text) ? `${base}${TICKET_IMAGE_PATH}` : undefined);

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
/** The team counts as active in a chat while its last message there is this recent; older, Zaid answers at once. */
export const TEAM_ACTIVE_SECS = 3600;
/** The WhatsApp Business app's own away/greeting message, which is not a team member answering. */
const APP_AUTO = /ان لم تتلقى رد خلال 24 ساعة|كيف اساعدك اليوم/;
export const isAppAuto = (m: { direction: string; source?: string; text?: string; caption?: string }) =>
  m.direction === "out" && m.source === "business_app" && APP_AUTO.test(m.text ?? m.caption ?? "");

type Msg = { id: string; direction: "in" | "out"; type: string; text?: string; caption?: string; timestamp: number; source?: string };

/**
 * When a team member last answered the merchant from the app (unix seconds): a Business-app message
 * sent within a day after a merchant message. A broadcast that opens a chat, a reminder sent hours after Zaid already
 * answered, and the app's away message do not count.
 */
export function teamRepliedAt(msgs: readonly Msg[]): number | undefined {
  let lastIn: number | undefined, at: number | undefined, prev: "in" | "team" | "other" = "other";
  for (const m of msgs) {
    if (m.type === "reaction" || isAppAuto(m)) continue;
    if (m.direction === "in") {
      lastIn = m.timestamp;
      prev = "in";
    } else if (m.source === "business_app" && lastIn !== undefined && m.timestamp - lastIn < TEAM_OWNS_SECS && (prev !== "other" || m.timestamp - lastIn < TEAM_JOIN_SECS)) {
      // answering the merchant, continuing their own replies, or stepping in soon after Zaid answered
      at = m.timestamp;
      prev = "team";
    } else prev = "other";
  }
  return at;
}

/** A team message after Zaid's answer counts as the team stepping in only this soon after the merchant wrote; later it is a reminder or campaign. */
export const TEAM_JOIN_SECS = 2 * 3600;

/** The merchant is answering the team: the last message from our side before this one was a team member's from the app. */
export function answersTeam(msgs: readonly Msg[], id: string | undefined): boolean {
  const i = id ? msgs.findIndex((m) => m.id === id) : -1;
  if (i < 0) return false;
  for (let j = i - 1; j >= 0; j--) {
    const m = msgs[j];
    if (m.direction !== "out" || m.type === "reaction" || isAppAuto(m)) continue;
    return m.source === "business_app";
  }
  return false;
}

/**
 * The team message this merchant message answers opened the chat: the merchant had not written in the day before it.
 * Only the team's "معك فريق زيادة" follow-up counts: Zaid takes its replies, while any other team message keeps the 15 minute wait.
 */
/** The team's follow-up opener: "هلا X، معك فريق زيادة ...". Messages from other products' teams (راصد، شاع) are not Zaid's. */
const FOLLOWUP = /معك\s[^\n]{0,25}فريق\s(?:تطبيق\s)?زيادة/;
export function teamOpener(msgs: readonly Msg[], id: string | undefined): boolean {
  const i = id ? msgs.findIndex((m) => m.id === id) : -1;
  if (i < 0) return false;
  let j = i - 1;
  while (j >= 0 && (msgs[j].direction !== "out" || msgs[j].type === "reaction" || isAppAuto(msgs[j]))) j--;
  const t = msgs[j];
  if (!t || t.source !== "business_app" || !FOLLOWUP.test(t.text ?? t.caption ?? "")) return false;
  return !msgs.slice(0, j).some((m) => m.direction === "in" && m.type !== "reaction" && t.timestamp - m.timestamp < TEAM_OWNS_SECS);
}

/** What the team told merchants is new in the app (their own follow-up message), for "وش تقدمون" and "المزايا" after that follow-up. */
export const WHATS_NEW_RULE = `When a merchant asks what is new, what we offer or the features (وش تقدمون، المزايا، وش الجديد) after our follow-up message about new features, answer with this list, in one message, then ask whether they want help trying it:
وش جديدنا في زيادة:
- لوحة تحكم مطورة بتجربة أسرع وخطوات أوضح لإنشاء الاقتراحات ومعاينتها.
- عروض الباقات (شرح: https://www.youtube.com/watch?v=e-cWqg43Ymw).
- اختبارات A/B للكوبونات (شرح: https://www.youtube.com/watch?v=e-cWqg43Ymw).
- تقارير وتحليلات أوضح: المشاهدات والتحويلات والإيرادات لكل اقتراح.
- نسخ الاقتراحات: أنشئ نسخة من أي اقتراح وعدّل عليها.
- إدارة أسهل: جدولة الاقتراحات، تشغيلها بدون تاريخ نهاية، ومتابعة الفواتير والاشتراك من مكان واحد.
- مركز إشعارات ودعم مباشر داخل لوحة التحكم.
Never claim more than this list. Do not answer with only "معك فريق زيادة" to such a question.`;

/** A team member told the merchant they are checking something ("بتأكد بخصوصه الحين"). */
const TEAM_PROMISE = /بتأكد|بتاكد|بنتأكد|بنتاكد|بشيك|بنشيك|اشيك عليه|بتحقق|بنتحقق|بنراجع|براجع|جاري (?:التحقق|التأكد|التاكد|المراجعة|الفحص|المتابعة)|ارجع لك|نرجع لك|برجع لك|بنرجع لك|بفيدك|نفيدك/;
/** The merchant reported something not working. */
const PROBLEM = /ما ?[يت]?ظهر|ما ?[يتا]?شتغل|مو شغال|مب شغال|مهو شغال|ماهو شغال|مشكل|خطأ|خطا|غلط|عطل|خربان|خربت|خرب|توقف|ما ?[يت]?طلع|ما ?[يت]?نفع|ما ?[يت]?زبط|ما ?[يت]?ضبط|ما ?[يت]?فتح|ما ?[يت]?وصل|ليش ما|error|bug|not working|doesn'?t work/i;
/** Sent once when the team said it is checking a problem and has not written again for TEAM_WAIT_SECS. */
export const HOLD_LINE = "جاري متابعة الإشكالية، شاكرين انتظارك.";
/**
 * The chat's last message is a team promise to check something, made right after the merchant reported a problem
 * (within two hours, in one of their last three messages). Small talk ("بتأكد ان امورك تمام") does not count.
 */
export function teamPromise<T extends Msg>(msgs: readonly T[]): T | undefined {
  const real = msgs.filter((m) => m.type !== "reaction" && !isAppAuto(m));
  const last = real[real.length - 1];
  if (!last || last.direction !== "out" || last.source !== "business_app" || !TEAM_PROMISE.test(last.text ?? last.caption ?? "")) return undefined;
  const ins = real.filter((m) => m.direction === "in" && last.timestamp - m.timestamp < 2 * 3600).slice(-3);
  return ins.some((m) => PROBLEM.test(m.text ?? m.caption ?? "")) ? last : undefined;
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
const MEETING_TALK = /اجتماع|إجتماع|ميتنق|ميتنج|موعد|مواعيد|جدول|الساع[هة]|وقت صلا|meeting|zoom|\bmeet\b|\bcall\b/i;

const TIME_WORDS = /[0-9٠-٩]|متاح|مناسب|يناسب|وقت|اليوم|بكر[هة]|بكرا|غد[اًا]?|الصبح|الظهر|العصر|المغرب|العشاء|مساء|صباح|الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|السبت|الجمعة|ألغي|الغي|أأجل|اأجل|أجل|تأجيل|تغيير|اغير|أغير/;
const bodyText = (m: Msg) => m.text ?? m.caption ?? "";

/**
 * Whether the merchant is arranging a meeting: the message or one of the few before it (within two hours)
 * talks about a meeting or a time. Zaid answers these at once even while the team is in the chat, because
 * it holds the calendar.
 */
/** Our messages that ask the merchant for what the booking still needs, and the one that confirms it. */
const BOOKING_ASK = /دعوة الاجتماع|حجز الموعد|سجلت .{0,30}(?:الاثنين|الثلاثاء|الأربعاء|الخميس|الأحد)/;
const BOOKED = /تم حجز موعدنا|موعدنا محجوز|ما قدرت أثبت الموعد/;
export function meetingTalk(msgs: readonly Msg[], id: string): boolean {
  const i = msgs.findIndex((m) => m.id === id);
  if (i < 0) return false;
  const at = msgs[i].timestamp;
  // mid-booking: we asked for the email or store link (or confirmed a time) and nothing confirmed the booking since, so any reply
  // ("صحيح", a link, "تمام") belongs to the booking, even one a team member prompted
  let ask = -1;
  for (let j = i - 1; j >= 0 && at - msgs[j].timestamp <= 6 * 3600; j--) {
    const t = bodyText(msgs[j]);
    if (msgs[j].direction !== "out" || isAppAuto(msgs[j])) continue;
    if (BOOKED.test(t)) break;
    if (BOOKING_ASK.test(t)) { ask = j; break; }
  }
  if (ask >= 0 && msgs[i].direction === "in" && msgs[i].type !== "reaction") return true;
  // the merchant's own words must be about a time, so a "تمام شكرا" after the team set the meeting stays with the team
  const own = bodyText(msgs[i]);
  if (!(MEETING_TALK.test(own) || TIME_WORDS.test(own) || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(own))) return false;
  return msgs.slice(Math.max(0, i - 6), i + 1).some((m) => at - m.timestamp <= 7200 && !isAppAuto(m) && MEETING_TALK.test(bodyText(m)));
}

/** Technical problems go to a support ticket in the merchant's own dashboard, never to WhatsApp. */
export const TICKET_RULE = `Technical problems: only when the merchant clearly says something is broken (they did it and it does not appear, an error message, a page or button that does not work, something that stopped working), never ask for their email, store link, store name or a screenshot, and never try to troubleshoot it. Reply with exactly this, with the dashboard link as a button labelled لوحة زيادة: حياك الله، عشان نتابع المشكلة معك بدقة، ارفع تذكرة من لوحة زيادة: ادخل لوحة زيادة ← المساعدة والملاحظات (أعلى الصفحة) ← تذكرة جديدة، واكتب فيها وش يظهر لك وأرفق صورة، والفريق التقني يتابعها معك.
The link depends on the merchant's platform (from <merchant>, or from what they said in the conversation): سلة (Salla) → https://dashboard.ziadah.app/login, زد (Zid) → https://web.ziadah.app/login. When the platform is unknown, give both buttons, labelled لوحة زيادة (سلة) and لوحة زيادة (زد).
Not a technical problem, so never send the ticket reply for it: a how-to question (كيف أتأكد، كيف أفعّل، وين ألقى، وش معنى), a question about numbers going up or down, or a general question. Answer those from <knowledge>, or with the unsure line when the answer is not there. When you cannot tell whether something is broken, answer the question as asked.
This overrides any instruction in <knowledge> to collect the store name, email or a screenshot for a technical problem. Cancellation, refund, charge complaints and upset merchants still get the handover line from the strict rules.`;

/** Added when the merchant is arranging a meeting: Zaid holds the calendar, so he finishes it even if a team member started it. */
export const MEETING_OWN_RULE = `The merchant is arranging a meeting right now, possibly with a team member who started it. You hold the calendar, so you finish it: never output [[SKIP]] here. A team member may have sent the merchant's email or store link on their behalf: take them from the conversation, and never ask again for what is already there. Follow the Meetings instructions exactly: if no time is agreed yet, offer the free times closest to what they asked for (for example tomorrow afternoon); if they chose a listed time and an email is in the conversation, book it; if the email is missing, ask for it. Do not repeat what the team already asked.`;

/** Keeps replies logical: answer what was just asked, know today's date, never push a meeting on someone who is busy. */
export function logicRule(ms: number): string {
  const today = new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);
  return `Reply logic (applies to every reply):
- Today is ${today} (Riyadh). If <merchant> shows an end date before today, the subscription has already ended: say it ended on that date, never "ينتهي" or "will end", and point to renewing from the app market. If the end date is today or later, say it ends on that date.
- Answer the merchant's last message first. If they ask who we are, what we do or why we wrote to them, answer that in one or two short lines before anything else (we are زيادة, an app on سلة وزد that raises the average order value with suggestions and offers shown to the customer while buying; learn more at https://www.ziadah.app), then offer the next step.
- If they ask for a quick explanation on the spot (for example "فهمني وش موضوعكم"), give that short explanation yourself; never refuse with "the explanation is only in a meeting". Offer the meeting afterwards as an option.
- If the merchant says they will send something (a link, an email, a number: برسلك، بارسل، راح أرسل), reply only that you are waiting (تمام، بانتظارك). Never say you will send it.
- If the merchant says they are busy, outside, or it is not a good time, do not list meeting times. Reply: على راحتك، متى ما فضيت أرسل لي وقت يناسبك وأرتب لك الموعد. List times only when they ask for a meeting or a time.
- Never repeat the same sentence or offer you already sent in this conversation; add something new or give the next step.
- Never ask the merchant to do something they just said they are doing.`;
}

/** Annual offer: pay one year, get a second year free. Ends at the end of this day, Riyadh time. */
export const OFFER_LAST_DAY = "2026-11-05";
const offerOn = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10) <= OFFER_LAST_DAY;

/** Prices from ziadah.app/pricing, and how Zaid answers "بكم" for a merchant whose plan we know. */
export function priceRule(ms: number): string {
  const offer = offerOn(ms);
  return `Prices (SAR): الانطلاقة سنوي فقط بـ 350 (لا يوجد لها اشتراك شهري). النمو 290 شهري أو 2,990 سنوي، الاحترافية 790 شهري أو 7,990 سنوي، الأعمال 1,990 شهري أو 15,990 سنوي.
${offer ? "Current offer: an annual subscription to النمو, الاحترافية or الأعمال = one year paid + one year free (سنة + سنة مجاناً). الانطلاقة is NOT in the offer: never say a second year free for it. This overrides any end date for this offer in <knowledge>." : "There is no annual offer now: never mention سنة + سنة مجاناً or any other offer."}
When the merchant asks the price (بكم، كم السعر، كم السنة، كم التجديد) and <merchant> lists their plan, answer for that plan only, without listing other plans: give its annual price${offer ? " and, unless it is الانطلاقة, say it comes with a second year free" : ""}, in one or two short sentences, for example: ${offer ? "حياك الله، باقتك النمو سنوي بـ 2,990 ريال ومعها سنة مجاناً." : "حياك الله، باقتك النمو سنوي بـ 2,990 ريال."} When a merchant asks about an offer or a discount and there is no current offer, say there is none now and steer to the annual subscription: it costs less than paying monthly for a year. Give the annual price of the plan they mention (or of النمو if none) and the pricing link, in two short sentences. Never say how many months it saves and never invent a percentage.
When the merchant says they want to subscribe (حاب أشترك، أبي أشترك) and <merchant> does not show an active plan, never call a plan "باقتك". Price the plan or the billing period they asked for (monthly or annual). If they did not name a plan, give the monthly prices of النمو والاحترافية والأعمال and the annual price of الانطلاقة, then ask which one they want. If they ask for monthly الانطلاقة, say it is annual only at 350.
If their plan is not known, give the pricing page link as a button labelled الباقات: [الباقات](https://www.ziadah.app/pricing).`;
}

/** What each plan includes, from ziadah.app/pricing. Zaid may only name a feature for a plan when it is listed here. */
export const PLANS_RULE = `Plan features (the only source for what a plan includes; it overrides the pricing page and <knowledge>):
- الانطلاقة: اقتراحات صفحة المنتج، عروض المنتجات، عروض الكميات، التحليلات، 60 نقطة ذكاء اصطناعي. لا تشمل: الكوبونات، الوصول للشحن المجاني.
- النمو: كل ما في الانطلاقة + اقتراحات السلة، الاقتراح بعد الإضافة وبعد الحذف، الكوبونات، عضوين للفريق، 600 نقطة. لا تشمل: الوصول للشحن المجاني، عروض الاستبدال، الاقتراح بعد الدفع، اقتراحات قيمة السلة.
- الاحترافية: كل ما في النمو + الاقتراح بعد الدفع، اقتراحات قيمة السلة، عروض الاستبدال، الوصول للشحن المجاني، تحليلات لكل منتج، دعم القالب، 6000 نقطة. لا تشمل: الصفحة الرئيسية، صفحة التصنيف، صفحة إتمام الطلب.
- الأعمال: كل ما في الاحترافية + الصفحة الرئيسية، صفحة التصنيف، صفحة إتمام الطلب، فريق غير محدود، مدير نجاح، مراجعة شهرية، دعم مخصص، 60000 نقطة.
- اشترِ أكثر ووفّر أكثر: متاحة في كل الباقات.
- الشراء معاً: في صفحة المنتج متاحة في كل الباقات، وعند حدث الإضافة للسلة من باقة النمو وأعلى.
- توصيات الذكاء الاصطناعي (AI Upsell): متاحة حالياً في كل الباقات بدون حد، لفترة محدودة.
- كوّن مجموعتك (Build Your Bundle) وأضف المزيد (Add More): من باقة النمو وأعلى. أضف المزيد غير اشترِ أكثر ووفّر أكثر.
- كوبونات بعد الشراء (Post-purchase Coupons): من الباقة الاحترافية وأعلى.
- رفع قيمة السلة (Cart Goal) هي اقتراحات قيمة السلة: من الباقة الاحترافية وأعلى.
- الفترة التجريبية تكون حسب الباقة التي يختارها التاجر. الانطلاقة لا توجد فيها فترة تجريبية.
Never say a plan includes a feature unless it is listed for that plan above. When asked about a feature in a plan that excludes it, say plainly it is not in their plan and name the lowest plan that has it. Never list a plan's features unless the merchant asked about them, and then only the ones they asked about. For a feature not listed above, reply with the unsure line.`;

/** A closing offer the merchant did not ask for ("تبين نراجع لك...؟"): taken off the end of a reply that says something else. */
const OFFER = /(?:^|[.!؟?\n]\s*)((?:تب[يغ]ن?|تبون|تحب(?:ين|ون)?|ودك|ودكم)\s[^.!؟?\n]*[؟?])\s*$/;
export function dropOffer(text: string): string {
  const m = OFFER.exec(text);
  if (!m || /\]\(https?:/.test(m[1])) return text;
  const head = text.slice(0, m.index + m[0].length - m[1].length).trimEnd();
  return head.replace(/[\s،,]+$/, "").length >= 10 ? head : text;
}
