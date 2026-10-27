import type { Action, Cond, Graph, Trigger } from "@/lib/flows/types";

export type EF = {
  id?: string;
  name: string;
  enabled: boolean;
  account: string;
  trigger: Trigger;
  match: "all" | "any";
  conditions: Cond[];
  actions: Action[];
  /** node graph; flows saved before the node editor have none and are converted when opened */
  graph?: Graph;
  mode: "auto" | "approve" | "dry";
  maxAgeMinutes: number;
  cooldownSeconds: number;
  maxPerHour: number;
  stopOnMatch: boolean;
  tz: string;
};

export type ActionType = Action["type"];

export const FIELD_LABEL: Record<string, string> = {
  text: "نص الرسالة", sender: "رقم المرسل", sender_name: "اسم المرسل", chat: "معرّف المحادثة", chat_name: "اسم المحادثة",
  chat_type: "نوع المحادثة (direct / group)", type: "نوع الرسالة (text / image / audio…)", has_media: "فيها ميديا", direction: "الاتجاه (in / out)",
  from_owner: "الرسالة منك أنت", self_chat: "المحادثة مع نفسك", hour: "الساعة (0-23)", weekday: "اليوم (0 = الأحد)", is_first: "أول رسالة من هذا الشخص", is_reply: "رد على رسالة", length: "طول النص", tag: "وسوم المحادثة", ai: "الذكاء الاصطناعي يحكم (سؤال نعم/لا)",
};

export const OP_LABEL: Record<string, string> = {
  contains: "يحتوي", not_contains: "لا يحتوي", contains_any: "يحتوي أي كلمة من", contains_all: "يحتوي كل الكلمات", equals: "يساوي", not_equals: "لا يساوي",
  starts_with: "يبدأ بـ", ends_with: "ينتهي بـ", regex: "يطابق regex", not_regex: "لا يطابق regex", in: "ضمن القائمة", not_in: "ليس ضمن القائمة",
  gt: "أكبر من", gte: "أكبر أو يساوي", lt: "أصغر من", lte: "أصغر أو يساوي", is_true: "صحيح", is_false: "خطأ", is_empty: "فارغ", not_empty: "غير فارغ", yes: "الجواب نعم",
};

export const NO_VALUE = new Set(["is_true", "is_false", "is_empty", "not_empty"]);

export const ACTION_LABEL: Record<ActionType, string> = {
  reply: "ردّ في نفس المحادثة", ai_reply: "الذكاء الاصطناعي يرد في نفس المحادثة", send: "أرسل رسالة لرقم آخر (أو لي)", ai: "الذكاء الاصطناعي يجهز نص (يُستخدم في {{ai}})",
  agent: "الذكاء الاصطناعي ينفذ مهمة بالموصلات (MCP)", react: "تفاعل بإيموجي", mark_read: "علّم كمقروءة", tag: "أضف وسم للمحادثة", webhook: "استدعِ رابط (Webhook)", delay: "انتظر قبل ما تكمل (تأخير)", stop: "أوقف باقي الفلوات لهذي الرسالة",
};

export function newAction(type: ActionType): Action {
  const ai = { prompt: "", context: 12, maxTokens: 500, scope: "chat" as const, hours: 24 };
  switch (type) {
    case "reply": return { type, text: "", quote: false };
    case "send": return { type, to: "me", text: "" };
    case "react": return { type, emoji: "👍" };
    case "tag": return { type, tag: "" };
    case "ai_reply": return { type, quote: false, ...ai };
    case "ai": return { type, ...ai };
    case "agent": return { type, prompt: "", confirm: true, connectors: [], maxTokens: 2000 };
    case "webhook": return { type, url: "", method: "POST", headers: {} };
    case "delay": return { type, minutes: 30, cancelOnReply: false };
    default: return { type } as Action;
  }
}

export const blankFlow = (): EF => ({
  name: "فلو جديد", enabled: true, account: "*", trigger: { type: "message", direction: "in", chats: "direct" }, match: "all",
  conditions: [], actions: [newAction("reply")], mode: "approve", maxAgeMinutes: 180, cooldownSeconds: 0, maxPerHour: 30, stopOnMatch: false, tz: "Asia/Riyadh",
});

export const PRESETS: { id: string; title: string; hint: string; make: () => EF }[] = [
  {
    id: "claude-all",
    title: "الذكاء الاصطناعي يرد على كل رسالة خاصة",
    hint: "كل ما توصلك رسالة، الذكاء الاصطناعي يقرأ المحادثة ويكتب الرد. يبدأ بوضع المسودة، وتحوله لتلقائي لما تثق فيه.",
    make: () => ({
      ...blankFlow(), name: "الذكاء الاصطناعي يرد على الرسائل", cooldownSeconds: 20, maxPerHour: 20,
      actions: [{ ...(newAction("ai_reply") as Extract<Action, { type: "ai_reply" }>), prompt: "" }],
    }),
  },
  {
    id: "keywords",
    title: "رد آلي على كلمات مفتاحية",
    hint: "لو الرسالة فيها \"سعر\" أو \"كم\" رد بنص ثابت.",
    make: () => ({
      ...blankFlow(), name: "رد على سؤال السعر", cooldownSeconds: 3600,
      conditions: [{ field: "text", op: "contains_any", value: "سعر, كم, price" }],
      actions: [{ type: "reply", text: "هلا {{sender_name}}! الأسعار موجودة عندنا هنا: https://example.com/prices وأي شي ثاني أنا حاضر.", quote: true }],
    }),
  },
  {
    id: "after-hours",
    title: "رد خارج أوقات الدوام",
    hint: "قبل 9 الصبح أو بعد 5 المغرب (بتوقيت الرياض).",
    make: () => ({
      ...blankFlow(), name: "خارج الدوام", match: "any", cooldownSeconds: 6 * 3600,
      conditions: [{ field: "hour", op: "lt", value: 9 }, { field: "hour", op: "gte", value: 17 }],
      actions: [{ type: "reply", text: "هلا! وصلتني رسالتك وأرد عليك أول ما أرجع للدوام بكرة إن شاء الله.", quote: false }],
    }),
  },
  {
    id: "digest",
    title: "ملخص يومي من الذكاء الاصطناعي يوصلني",
    hint: "كل يوم الساعة 8 صباحاً (أو أول مزامنة بعدها) يلخص الذكاء الاصطناعي رسائل آخر 24 ساعة ويرسلها لك على واتساب.",
    make: () => ({
      ...blankFlow(), name: "ملخص يومي", mode: "auto", trigger: { type: "schedule", everyMinutes: 1440, atHour: 8 },
      actions: [
        { ...(newAction("ai") as Extract<Action, { type: "ai" }>), scope: "recent", hours: 24, context: 15, prompt: "لخّص لي رسائل آخر 24 ساعة بنقاط قصيرة: من كتب لي، وإيش يبي، وإيش لازم أرد عليه أو أسويه. ابدأ بالأهم." },
        { type: "send", to: "me", text: "ملخص رسائلك:\n\n{{ai}}" },
      ],
    }),
  },
  {
    id: "ai-tag",
    title: "الذكاء الاصطناعي يوسم الرسائل المهمة وينبهني",
    hint: "لو الذكاء الاصطناعي حكم إن الرسالة طلب مستعجل أو فاتورة، يوسمها ويكلم رابط (مثلاً ntfy أو Zapier).",
    make: () => ({
      ...blankFlow(), name: "تنبيه الرسائل المستعجلة", mode: "auto",
      conditions: [{ field: "ai", op: "yes", value: "هل الرسالة طلب مستعجل أو مشكلة تحتاج تدخل صاحب الحساب شخصياً؟" }],
      actions: [{ type: "tag", tag: "مستعجل" }, { type: "webhook", url: "https://ntfy.sh/CHANGE-ME", method: "POST", headers: {} }],
    }),
  },
  {
    id: "assistant",
    title: "الذكاء الاصطناعي داخل واتساب: أرسل له مهمة وينفذها",
    hint: "اكتب مهمتك في محادثتك مع نفسك. الذكاء الاصطناعي يرد بالخطة، وتقول \"نعم\" فينفذها بالموصلات اللي أضفتها، ويرسل لك النتيجة. فقط رسائلك أنت تُنفَّذ.",
    make: () => ({
      ...blankFlow(), name: "مساعد الذكاء الاصطناعي", mode: "auto", trigger: { type: "message", direction: "out", chats: "direct" }, maxAgeMinutes: 30, maxPerHour: 30,
      conditions: [{ field: "self_chat", op: "is_true" }],
      actions: [newAction("agent")],
    }),
  },
  {
    id: "report",
    title: "تقرير مجدول من الذكاء الاصطناعي يوصلني (أو القروب)",
    hint: "مهمة بالموصلات تتنفذ بجدولة (مثلاً مبيعات المتجر كل صباح) والنتيجة تنرسل لك. غيّر \"me\" برقم أو معرّف قروب.",
    make: () => ({
      ...blankFlow(), name: "تقرير الصباح", mode: "auto", trigger: { type: "schedule", everyMinutes: 1440, atHour: 8 },
      actions: [
        { ...(newAction("agent") as Extract<Action, { type: "agent" }>), confirm: false, prompt: "جهّز لي تقرير مبيعات أمس من المتجر: عدد الطلبات، الإجمالي، أكثر المنتجات مبيعاً، وأي مشكلة." },
        { type: "send", to: "me", text: "🤖 {{ai}}" },
      ],
    }),
  },
  {
    id: "auto-read",
    title: "تعليم الرسائل كمقروءة تلقائياً",
    hint: "أي رسالة من رقم معين (أو كلها) تنعلّم مقروءة.",
    make: () => ({ ...blankFlow(), name: "قراءة تلقائية", mode: "auto", actions: [{ type: "mark_read" }] }),
  },
];
