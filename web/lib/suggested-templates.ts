// Ready-made Ziadah templates the dashboard offers to fill into the template form.
// Wording approved by the owner (Claude Doc "قوالب واتساب زيادة"); Meta still reviews each one.

export type SuggestedTemplate = {
  title: string;
  name: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  examples: string[];
  footer?: string;
  optOut?: boolean;
  urlText?: string;
  url?: string;
  /** Sample header image under /public, uploaded to Meta when the template is submitted. */
  image?: string;
};

const STOP = "لإيقاف الرسائل التسويقية اضغط إيقاف";

export const SUGGESTED_TEMPLATES: SuggestedTemplate[] = [
  {
    title: "متابعة استفسار",
    name: "ziadah_support_followup",
    category: "UTILITY",
    body: "هلا {{1}}، معك زيد من فريق دعم زيادة. نتابع معك بخصوص استفسارك عن {{2}}. رد على هذي الرسالة ونكمل معك.",
    examples: ["محمد", "ربط المتجر بزد"],
  },
  {
    title: "تذكير بإكمال التفعيل",
    name: "ziadah_setup_reminder",
    category: "UTILITY",
    body: "هلا {{1}}، لاحظنا إن تفعيل زيادة على متجرك {{2}} ما اكتمل. تقدر تكمل الخطوات من لوحة التطبيق، ولو تحتاج مساعدة رد علينا هنا.",
    examples: ["محمد", "متجر الورد"],
    urlText: "افتح زيادة",
    url: "https://www.ziadah.app",
  },
  {
    title: "تحديث على طلب",
    name: "ziadah_case_update",
    category: "UTILITY",
    body: "هلا {{1}}، عندنا تحديث بخصوص طلبك مع دعم زيادة. رد على هذي الرسالة عشان نكمل معك.",
    examples: ["محمد"],
  },
  {
    title: "عرض الاشتراك السنوي (صورة)",
    name: "ziadah_annual_offer",
    category: "MARKETING",
    body: "هلا {{1}}، عرض زيادة السنوي: اشترك سنة وخذ سنة ثانية مجاناً، والعرض لين {{2}}. زيادة تخصص تجربة كل عميل في متجرك حسب منطقته وجهازه ومشترياته.",
    examples: ["محمد", "3 نوفمبر"],
    footer: STOP,
    optOut: true,
    urlText: "شوف الباقات",
    url: "https://www.ziadah.app/pricing",
    image: "/templates/ziadah_annual_offer.png",
  },
  {
    title: "ميزة جديدة (صورة)",
    name: "ziadah_new_feature",
    category: "MARKETING",
    body: "هلا {{1}}، نزلنا ميزة جديدة في زيادة: {{2}}. فعلها من لوحة التطبيق وشوف أثرها على مبيعات متجرك.",
    examples: ["محمد", "توصيات حسب منطقة العميل"],
    footer: STOP,
    optOut: true,
    urlText: "اعرف أكثر",
    url: "https://www.ziadah.app",
    image: "/templates/ziadah_new_feature.png",
  },
];
