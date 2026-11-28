// The merchant survey for the marketing number, as flows for the existing automation engine.
// A merchant who writes "تم" gets the survey; the choice (1, 2 or 3) decides the answer. Progress is kept
// in tags, so every step runs once. Files arrive as a tag the dashboard shows for review.
// Imported flows stay switched off until someone enables them, as with every imported flow.

import type { PortableFlow } from "./flows/portable";

const ACCOUNT = "official";

export const TAG = {
  wait: "استبيان: بانتظار الاختيار",
  answered: "استبيان: أجاب",
  file: "استبيان: بانتظار ملف الطلبات",
  received: "استبيان: وصل الملف",
  newStore: "تصنيف: متجر جديد",
  growth: "تصنيف: فرصة نمو",
  expansion: "تصنيف: فرصة توسع",
  review: "ملف طلبات: للمراجعة",
};

// "تم" as a word of its own: "تم.", "تم ✅", "تم، أبشر" count; "تماماً" does not.
const START = "^\\s*تم(?![\\u0621-\\u064A])";
const CHOICE = (n: number) => `^\\s*${n}(?!\\d)`;

export const TEXT = {
  intro: [
    "أبشر، يسعدنا نساعدك في تنمية مبيعات متجرك من خلال زيادة 💜",
    "",
    "زيادة تساعدك على رفع حجم الطلب وزيادة متوسط قيمة السلة، من خلال استهداف رحلة عملائك الحالية وتشجيعهم على شراء منتجات أكثر في الطلب الواحد، دون الحاجة إلى إضافة منتجات جديدة أو تغيير طبيعة نشاطك.",
    "",
    "فكرتنا تشبه التجربة اللي نشوفها في نون وأمازون وكيتا؛ لما تظهر للعميل منتجات وعروض مرتبطة باهتمامه وقرارات شرائه، فيتحول كل طلب إلى فرصة لتحقيق مبيعات أعلى.",
    "",
    "حتى نقدر نحدد فرص النمو المناسبة لمتجرك، اختر الحالة الأقرب لك:",
    "",
    "1. متجر جديد ولم يبدأ باستقبال الطلبات.",
    "2. متجري لديه مبيعات ضعيفة إلى متوسطة، وأرغب في زيادة المبيعات ومتوسط قيمة السلة.",
    "3. متجري يحقق مبيعات عالية، وأرغب في زيادة الإيرادات والتوسع.",
    "",
    "رد برقم الخيار (1 أو 2 أو 3).",
  ].join("\n"),
  newStore: [
    "نشكرك على اهتمامك بزيادة وثقتك فينا 💜",
    "",
    "زيادة مصممة لمساعدة المتاجر اللي عندها طلبات ومبيعات فعلية على تحقيق إيرادات أعلى من زوارها وعملائها الحاليين.",
    "",
    "لذلك نفضّل أن تبدأ معنا بعد انطلاق مبيعات متجرك، حتى نتمكن من تحليل بيانات الطلبات وتحديد فرص حقيقية لزيادة حجم السلة وتحقيق نتائج ملموسة وقابلة للقياس.",
    "",
    "نتمنى لك بداية موفقة، ونسعد بانضمامك إلينا مستقبلاً! 🚀",
  ].join("\n"),
  growth: [
    "ممتاز! 💜",
    "",
    "هنا نقدر نساعدك تكتشف فرص حقيقية لزيادة مبيعات متجرك من نفس الزوار والعملاء الحاليين، من خلال تشجيعهم على إضافة منتجات أكثر إلى طلباتهم ورفع متوسط قيمة السلة.",
    "",
    "حتى نجهز لك خطة مستهدفة مبنية على أرقام متجرك الفعلية، نحتاج ملف الطلبات لآخر 3 أشهر بصيغة Excel أو CSV. نحتاج منه المنتجات في كل طلب والكميات، ولا نحتاج أي بيانات شخصية للعملاء.",
    "",
    "سنحلل أداء الطلبات ومتوسط السلة وفرص البيع الإضافي، ونحدد لك مستهدفات نمو واقعية وخطوات تنفيذية واضحة. 🚀",
  ].join("\n"),
  expansion: [
    "رائع! 🔥",
    "",
    "بما أن متجرك يحقق مبيعات جيدة، فالفرصة الآن هي استخراج قيمة أكبر من كل زيارة وكل طلب.",
    "",
    "سنساعدك على اكتشاف فرص البيع الإضافي والبيع المتقاطع، وتحفيز العملاء على شراء منتجات أكثر في الطلب الواحد، بما يرفع متوسط قيمة السلة والإيرادات دون الحاجة إلى زيادة عدد الزوار بنفس النسبة.",
    "",
    "نأمل إرفاق ملف الطلبات لآخر 3 أشهر بصيغة Excel أو CSV، لنحلل أداء متجرك ونبني خطة توسع بأرقام ومستهدفات قابلة للقياس. 💜",
  ].join("\n"),
  fileOk: [
    "وصلنا الملف، يعطيك العافية! 💜",
    "",
    "بنراجع بيانات الطلبات ونحلل أداء متجرك لتحديد فرص زيادة حجم الطلب ومتوسط قيمة السلة، ونبني خطة نمو مستهدفة تناسب أرقامك الحالية.",
  ].join("\n"),
  fileWrong: "أحتاج ملف الطلبات بصيغة Excel (xlsx) أو CSV. تقدر تصدّره من قسم الطلبات في لوحة متجرك. وإذا تحتاج مساعدة، قل لي المنصة (زد أو سلة) وأشرح لك.",
};

const AI_PROMPT = [
  "أنت زيد، مساعد نمو المبيعات في منصة زيادة، وتتواصل مع التجار عبر واتساب.",
  "أسلوبك سعودي احترافي، ودود، مختصر، ومحفّز، بدون مبالغة.",
  "زيادة تساعد المتاجر على رفع حجم الطلب ومتوسط قيمة السلة، باقتراح منتجات مرتبطة وعروض تشجع العميل على إضافة منتجات أكثر، دون إضافة منتجات جديدة أو تغيير نشاط المتجر.",
  "التاجر الآن في الاستبيان ولم يختر بعد بين: 1) متجر جديد بدون طلبات، 2) مبيعات ضعيفة إلى متوسطة، 3) مبيعات عالية.",
  "إذا سأل عن شيء آخر، أجب بإيجاز، ثم وجّهه للاختيار بالرقم 1 أو 2 أو 3.",
  "قواعد صارمة: لا تعد بنسبة نمو أو إيرادات مضمونة، ولا تخترع أرقاماً أو نتائج، ولا تطلب كلمة مرور أو بيانات دخول، ولا تطلب معلومات غير ضرورية.",
  "إذا لم تكن رسالة التاجر واضحة، اسأله سؤالاً توضيحياً واحداً.",
  "إذا طلب التحدث مع أحد من الفريق، قل إنك ستحوّله للمسؤول.",
].join("\n");

const base = { account: ACCOUNT, mode: "auto" as const, stopOnMatch: true, match: "all" as const };
const text = (op: "regex" | "not_regex" | "contains" | "not_contains" | "equals" | "not_equals", value: string) => ({ field: "text" as const, op, value });
const tag = (op: "contains" | "not_contains", value: string) => ({ field: "tag" as const, op, value });

export function surveyFlows(): PortableFlow[] {
  return [
    {
      ...base,
      name: "استبيان: بدء عند تم",
      conditions: [text("regex", START), tag("not_contains", [TAG.wait, TAG.answered, TAG.file, TAG.received].join("،"))],
      actions: [
        { type: "reply", text: TEXT.intro, quote: false },
        { type: "tag", tag: TAG.wait },
      ],
    },
    {
      ...base,
      name: "استبيان: الخيار 1 (متجر جديد)",
      conditions: [tag("contains", TAG.wait), tag("not_contains", TAG.answered), text("regex", CHOICE(1))],
      actions: [
        { type: "reply", text: TEXT.newStore, quote: false },
        { type: "tag", tag: TAG.answered },
        { type: "tag", tag: TAG.newStore },
      ],
    },
    {
      ...base,
      name: "استبيان: الخيار 2 (مبيعات متوسطة)",
      conditions: [tag("contains", TAG.wait), tag("not_contains", TAG.answered), text("regex", CHOICE(2))],
      actions: [
        { type: "reply", text: TEXT.growth, quote: false },
        { type: "tag", tag: TAG.answered },
        { type: "tag", tag: TAG.growth },
        { type: "tag", tag: TAG.file },
      ],
    },
    {
      ...base,
      name: "استبيان: الخيار 3 (مبيعات عالية)",
      conditions: [tag("contains", TAG.wait), tag("not_contains", TAG.answered), text("regex", CHOICE(3))],
      actions: [
        { type: "reply", text: TEXT.expansion, quote: false },
        { type: "tag", tag: TAG.answered },
        { type: "tag", tag: TAG.expansion },
        { type: "tag", tag: TAG.file },
      ],
    },
    {
      ...base,
      name: "استبيان: استلام ملف الطلبات",
      conditions: [tag("contains", TAG.file), tag("not_contains", TAG.received), { field: "type", op: "equals", value: "document" }],
      actions: [
        { type: "reply", text: TEXT.fileOk, quote: false },
        { type: "tag", tag: TAG.received },
        { type: "tag", tag: TAG.review },
      ],
    },
    {
      ...base,
      name: "استبيان: تذكير بصيغة الملف",
      conditions: [tag("contains", TAG.file), tag("not_contains", TAG.received), { field: "type", op: "not_equals", value: "document" }],
      actions: [{ type: "reply", text: TEXT.fileWrong, quote: false }],
    },
    {
      name: "استبيان: أسئلة أثناء الاختيار",
      account: ACCOUNT,
      mode: "auto",
      match: "all",
      stopOnMatch: true,
      conditions: [tag("contains", TAG.wait), tag("not_contains", TAG.answered), { field: "type", op: "equals", value: "text" }, text("not_regex", "^\\s*(تم(?![\\u0621-\\u064A])|[123](?!\\d))")],
      actions: [{ type: "ai_reply", prompt: AI_PROMPT, quote: false, scope: "chat", context: 12, maxTokens: 500, knowledge: false }],
    },
  ] as PortableFlow[];
}
