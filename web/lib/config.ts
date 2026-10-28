// Runtime configuration for the official (WhatsApp Cloud API) mode.
// Every value comes from Vercel environment variables; nothing is hard-coded.

export type Config = {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  appSecret: string;
  verifyToken: string;
  mcpSecret: string;
  graphVersion: string;
  redisUrl: string;
  redisToken: string;
};

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    wabaId: env.WHATSAPP_WABA_ID ?? "",
    appSecret: env.META_APP_SECRET ?? "",
    verifyToken: env.WEBHOOK_VERIFY_TOKEN ?? "",
    mcpSecret: env.MCP_SECRET ?? "",
    graphVersion: env.GRAPH_API_VERSION || "v26.0",
    // Upstash via the Vercel Marketplace injects KV_REST_API_*; a direct
    // Upstash database uses UPSTASH_REDIS_REST_*. Accept either.
    redisUrl: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "",
    redisToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "",
  };
}

export type Check = { key: string; label: string; ok: boolean; hint: string };

/** Which settings are present. Never returns the values themselves. */
export function configChecks(c: Config): Check[] {
  return [
    { key: "WHATSAPP_ACCESS_TOKEN", label: "مفتاح الوصول من Meta", ok: !!c.accessToken, hint: "System User access token بصلاحيات whatsapp_business_messaging و whatsapp_business_management" },
    { key: "WHATSAPP_PHONE_NUMBER_ID", label: "معرّف رقم الهاتف", ok: !!c.phoneNumberId, hint: "من صفحة WhatsApp > API Setup في تطبيقك على Meta" },
    { key: "WHATSAPP_WABA_ID", label: "معرّف حساب الأعمال (WABA)", ok: !!c.wabaId, hint: "يحتاجه عرض القوالب فقط" },
    { key: "META_APP_SECRET", label: "App Secret", ok: !!c.appSecret, hint: "من App settings > Basic، للتحقق من توقيع الـ Webhook" },
    { key: "WEBHOOK_VERIFY_TOKEN", label: "رمز تحقق الـ Webhook", ok: !!c.verifyToken, hint: "أي نص عشوائي تختاره، وتكتبه نفسه في إعدادات Webhook عند Meta" },
    { key: "MCP_SECRET", label: "كلمة سر الـ MCP", ok: c.mcpSecret.length >= 24 && /^[A-Za-z0-9_.~-]+$/.test(c.mcpSecret), hint: "نص عشوائي 24 حرف أو أكثر من حروف وأرقام فقط (بدون # ? & + @ أو مسافة)؛ بدونه السيرفر يرفض كل الطلبات" },
    { key: "CRON_SECRET", label: "كلمة سر المزامنة اليومية", ok: !!process.env.CRON_SECRET, hint: "للوضع الشخصي على فيرسل: يتصل مرة يومياً عشان ما ينفصل الجهاز" },
    { key: "KV_REST_API_URL", label: "قاعدة بيانات Redis", ok: !!c.redisUrl && !!c.redisToken, hint: "أضف Upstash Redis من تبويب Storage في مشروعك على فيرسل" },
  ];
}
