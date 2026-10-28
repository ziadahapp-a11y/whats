import { Code } from "@/components/Code";
import { Copy, Field } from "@/components/Copy";
import { Mark } from "@/components/Mark";
import { Secrets } from "@/components/Secrets";
import { origin as getOrigin } from "@/lib/origin";

export const metadata = { title: "دليل الإعداد الكامل | واتساب MCP", description: "كل خطوات التثبيت والربط: فيرسل، قاعدة البيانات، مفاتيح الذكاء الاصطناعي، واتساب، Claude، الفلوات والمساعد." };

const ENVS: [string, string, string][] = [
  ["MCP_SECRET", "مطلوب", "كلمة سر رئيسية للوحة التحكم، 24 حرف أو أكثر عشوائية"],
  ["CRON_SECRET", "مطلوب", "كلمة سر للمزامنة المجدولة، غير الأولى"],
  ["KV_REST_API_URL / KV_REST_API_TOKEN", "تلقائي", "تنضاف لما تربط Upstash Redis بالمشروع"],
  ["ANTHROPIC_API_KEY", "اختياري", "مفتاح Claude، للردود والمساعد"],
  ["AI_MODEL", "اختياري", "موديل Claude، الافتراضي claude-sonnet-5-5"],
  ["AI_COMPAT_URL / AI_COMPAT_KEY / AI_COMPAT_MODEL", "اختياري", "مزود رخيص متوافق مع OpenAI (DeepSeek، Qwen، Kimi، GLM…)"],
  ["AI_COMPAT_VISION", "اختياري", "ضع 1 لو نموذج المزود الرخيص يقرأ الصور"],
  ["AI_DEFAULT_PROVIDER", "اختياري", "ضع cheap ليكون المزود الرخيص هو الافتراضي"],
  ["AI_MAX_PER_DAY", "اختياري", "حد يومي لطلبات الذكاء الاصطناعي، الافتراضي 300"],
  ["FLOW_CHAT_HOURLY_CAP", "اختياري", "حد الرسائل التلقائية لكل محادثة في الساعة، الافتراضي 10"],
  ["MCP_SECRETS", "اختياري", "مفاتيح إضافية بصلاحية كاملة، مفصولة بفاصلة"],
  ["APP_URL", "اختياري", "عنوان نسختك لو تستخدم دومين خاص (لروابط الملفات)"],
];

const PROVIDERS: [string, string][] = [
  ["DeepSeek", "https://api.deepseek.com"],
  ["Qwen (علي بابا، دولي)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  ["Kimi (Moonshot)", "https://api.moonshot.ai/v1"],
  ["GLM (Z.AI)", "https://api.z.ai/api/paas/v4"],
  ["OpenRouter (يجمع عدة نماذج)", "https://openrouter.ai/api/v1"],
];

export const dynamic = "force-dynamic";

export default async function Guide() {
  const origin = await getOrigin();
  return (
    <div className="wrap">
      <header className="top">
        <a className="mark" href="/">
          <Mark />
          واتساب MCP
        </a>
        <nav aria-label="روابط">
          <a href="/">الرئيسية</a>
          <a className="btn solid" href="/personal">افتح النظام</a>
        </nav>
      </header>
      <main>
        <section style={{ borderTop: 0 }}>
          <h1>دليل الإعداد الكامل</h1>
          <p className="intro">من الصفر لين يشتغل كل شي: فيرسل، قاعدة البيانات، الذكاء الاصطناعي، واتساب، وClaude. تحتاج حوالي 15 دقيقة.</p>
          <p>
            <a className="btn solid" href="/personal">افتح النظام</a>
          </p>
        </section>

        <nav className="toc" aria-label="فهرس الدليل">
          {[["s1", "فيرسل"], ["s2", "المتغيرات"], ["s3", "الذكاء الاصطناعي"], ["s4", "ربط الرقم"], ["s5", "ربط Claude"], ["s6", "المعرفة"], ["s7", "الفلوات"], ["s8", "المزامنة"], ["s9", "الرقم الرسمي"], ["s10", "المشاكل"]].map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}
        </nav>
        <section aria-labelledby="s1">
          <h2 id="s1">1. حساب فيرسل ونشر النسخة</h2>
          <Secrets />
          <ol className="steps">
            <li><strong>أنشئ حساب Vercel</strong><p>من vercel.com بخطة Hobby المجانية، وسجّل بحساب GitHub.</p></li>
            <li><strong>اضغط «انشر نسختك» من الصفحة الرئيسية</strong><p>يستنسخ المشروع لحسابك على GitHub وينشره. المستودع الأصلي لازم يكون Public.</p></li>
            <li><strong>اختر MCP_SECRET و CRON_SECRET</strong><p>نصين عشوائيين طويلين (24 حرف أو أكثر) مختلفين، من حروف وأرقام فقط (بدون # ? & + @ أو مسافات، لأنها تخرّب روابط الربط). استخدم زر التوليد فوق. احفظهم في مدير كلمات المرور. MCP_SECRET هو اللي تدخل فيه للوحة التحكم، فلا تشاركه.</p></li>
            <li><strong>أضف قاعدة البيانات (Upstash Redis)</strong><p>أسهل طريقة: مشروعك ← Storage ← Create ← Upstash ← Redis ← اختر الخطة المجانية (Free) ← Connect، ثم Redeploy. إذا ما ظهرت الخطة المجانية (حساب Upstash عندك فيه قاعدة مجانية أصلاً، والمسموح قاعدة وحدة)، استخدم الطريقة البديلة تحت.</p></li>
            <li><strong>بديل: قاعدة من موقع Upstash مباشرة</strong><p>من console.upstash.com (بحساب جديد لو القديم ممتلئ) أنشئ Redis مجانية، وانسخ <Copy>REST URL</Copy> و<Copy>REST Token</Copy> وضعهم في فيرسل كمتغيرين: <Copy>KV_REST_API_URL</Copy> و<Copy>KV_REST_API_TOKEN</Copy>، ثم Redeploy. لا تشارك قاعدة بين عميلين.</p></li>
            <li><strong>عطّل حماية النشر</strong><p>Settings ← Deployment Protection ← أوقف Vercel Authentication للإنتاج. بدونها يظهر Claude خطأ تسجيل دخول لأنه ما يقدر يوصل للرابط.</p></li>
          </ol>
        </section>

        <section aria-labelledby="s2">
          <h2 id="s2">2. المتغيرات (Environment Variables)</h2>
          <p className="intro">من Settings ← Environment Variables في مشروعك. بعد أي تغيير اعمل Redeploy.</p>
          <div className="table-scroll">
            <table className="compare">
              <thead><tr><th scope="col">المتغير</th><th scope="col">النوع</th><th scope="col">وظيفته</th></tr></thead>
              <tbody>
                {ENVS.map(([k, t, d]) => (
                  <tr key={k}><td className="vars">{k.split(" / ").map((n) => <Copy key={n}>{n}</Copy>)}</td><td>{t}</td><td>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="s3">
          <h2 id="s3">3. مفتاح الذكاء الاصطناعي</h2>
          <p className="intro">تحتاج مفتاح واحد على الأقل لردود Claude والملخصات والمساعد. اختر طريقة أو اجمع الاثنتين.</p>
          <div className="features">
            <div className="feature">
              <h3>Claude (Anthropic)</h3>
              <ul>
                <li>من console.anthropic.com أنشئ حساب وضع رصيد.</li>
                <li>API Keys ← Create Key.</li>
                <li>ضعه في <Copy>ANTHROPIC_API_KEY</Copy>.</li>
              </ul>
              <p>الأدق في تنفيذ المهام بالأدوات، والموصلات تشتغل معه مباشرة.</p>
            </div>
            <div className="feature">
              <h3>مزود رخيص (متوافق مع OpenAI)</h3>
              <ul>
                <li>أنشئ مفتاح من موقع المزود.</li>
                <li><Copy>AI_COMPAT_URL</Copy> = العنوان الأساسي (جدول تحت).</li>
                <li><Copy>AI_COMPAT_KEY</Copy> = المفتاح.</li>
                <li><Copy>AI_COMPAT_MODEL</Copy> = اسم الموديل من لوحة المزود (يفضّل فئة Flash).</li>
              </ul>
              <p>أرخص بكثير للردود. للمساعد بالأدوات اختر نموذج يدعم function calling.</p>
            </div>
          </div>
          <h3>الطريقة الأسهل: مزود رخيص مثل DeepSeek</h3>
          <ol className="steps">
            <li><strong>أنشئ مفتاح API</strong><p>من منصة DeepSeek (platform.deepseek.com). لا تشاركه مع أحد ولا ترسله في أي محادثة.</p></li>
            <li><strong>أضف المتغيرات في Vercel</strong><p>مشروعك ← Settings ← Environment Variables ← Add. انسخ الاسم في خانة Key والقيمة في خانة Value، وكرر لكل سطر:</p>
              <div className="fields">
                <Field name="Key" value="AI_COMPAT_URL" note="القيمة ↓" />
                <Field name="Value" value="https://api.deepseek.com" />
                <Field name="Key" value="AI_COMPAT_KEY" note="القيمة: مفتاحك من DeepSeek (لا تنسخه هنا)" />
                <Field name="Key" value="AI_COMPAT_MODEL" note="القيمة ↓" />
                <Field name="Value" value="deepseek-flash" note="الأرخص ويدعم الأدوات والصور. الأقوى: deepseek-v4-pro (بدون صور)" />
              </div></li>
            <li><strong>Redeploy</strong><p>من تبويب Deployments ← النقاط الثلاث على آخر نشر ← Redeploy.</p></li>
            <li><strong>تأكد بزر الاختبار</strong><p>افتح <Copy value={origin + "/personal"}>/personal</Copy> واضغط «اختبر الذكاء الاصطناعي». يرسل سؤال صغير للمزود ويقول لك يشتغل أو وش الخطأ (مفتاح غلط، اسم موديل غلط). بعدها جرّب فلو بسيط قبل ما تفعّله تلقائياً.</p></li>
          </ol>
          <h3>أو Claude</h3>
          <p>أضف <Copy>ANTHROPIC_API_KEY</Copy> من console.anthropic.com ثم Redeploy. هذا الأدق للمساعد اللي ينفذ مهام بالموصلات.</p>
          <h3>عناوين المزودين</h3>
          <div className="fields">
            {PROVIDERS.map(([n, u]) => (
              <Field key={n} name={n} value={u} />
            ))}
          </div>
          <p>العناوين من وثائق المزودين وقت الكتابة. تأكد منها من لوحة كل مزود قبل الاستخدام.</p>
        </section>

        <section aria-labelledby="s4">
          <h2 id="s4">4. ربط رقم واتساب</h2>
          <ol className="steps">
            <li><strong>افتح <Copy value={origin + "/personal"}>/personal</Copy> في نسختك</strong><p>أدخل MCP_SECRET.</p></li>
            <li><strong>اكتب رقمك بالصيغة الدولية</strong><p>مثل 9665XXXXXXXX بدون + أو أصفار.</p></li>
            <li><strong>أدخل الرمز في واتساب</strong><p>الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف بدلاً من ذلك، وأدخل الرمز المكوّن من 8 خانات.</p></li>
            <li><strong>أرقام إضافية</strong><p>من نفس الصفحة أضف حتى 10 أرقام، وكل رقم له جلسته ورسائله.</p></li>
          </ol>
          <div className="note"><p>الجلسة تنقطع لو أزلت الجهاز من الأجهزة المرتبطة في جوالك. اربط من جديد.</p></div>
        </section>

        <section aria-labelledby="s5">
          <h2 id="s5">5. ربط Claude أو Cursor</h2>
          <ol className="steps">
            <li><strong>أنشئ مفتاح جهاز</strong><p>في <Copy value={origin + "/personal"}>/personal</Copy> ← المفاتيح: سمّه، اختر الأرقام، واختر قراءة فقط أو قراءة وإرسال. المفتاح يظهر مرة وحدة.</p></li>
            <li><strong>انسخ الرابط الجاهز واستخدمه حسب برنامجك</strong><p>الرابط يحتوي المفتاح، فعامله ككلمة سر.</p></li>
          </ol>
          <Code label="Claude Code">{`claude mcp add --transport http whatsapp "${origin}/api/personal/mcp?key=wmk_..."`}</Code>
          <Code label="Cursor و أغلب البرامج">{`{ "mcpServers": { "whatsapp": { "type": "http", "url": "${origin}/api/personal/mcp?key=wmk_..." } } }`}</Code>
          <Code label="رابط نسختك لـ Claude.ai (الصقه في الموصل المخصص)">{`${origin}/api/personal/mcp?key=wmk_...`}</Code>
          <p>
            <strong>Claude.ai / تطبيق Claude:</strong> الإعدادات ← الموصلات (Connectors) ← إضافة موصل مخصص، والصق الرابط. إن ظهر خطأ تسجيل، تأكد من تعطيل حماية Vercel وإن الرابط فيه <Copy>?key=</Copy> صحيح.
          </p>
          <p>لتثبيت رقم معين في الرابط أضف <Copy>{"&account=ID"}</Copy> في آخره.</p>
        </section>

        <section aria-labelledby="s6">
          <h2 id="s6">6. قاعدة المعرفة والموصلات</h2>
          <ol className="steps">
            <li><strong>قاعدة المعرفة</strong><p>من <Copy value={origin + "/personal/knowledge"}>/personal/knowledge</Copy>: أضف رابط الهلب سنتر (مع سحب الصفحات المرتبطة)، أو ارفع PDF وWord وMarkdown (حتى 4MB)، أو الصق نصاً. جرّب سؤالاً من نفس الصفحة.</p></li>
            <li><strong>الموصلات</strong><p>في نفس الصفحة: أضف رابط خادم MCP (متجرك، التصميم، جدولة النشر) مع مفتاحه لو يحتاج. لازم https عام.</p></li>
          </ol>
        </section>

        <section aria-labelledby="s7">
          <h2 id="s7">7. الفلوات والمساعد</h2>
          <ol className="steps">
            <li><strong>ابدأ من قالب</strong><p>من <Copy value={origin + "/personal/flows"}>/personal/flows</Copy> اختر قالب (رد Claude، كلمات مفتاحية، ملخص يومي، تقرير مجدول، مساعد واتساب).</p></li>
            <li><strong>جرّب بوضع «تجربة» ثم «مسودة»</strong><p>الوضع التلقائي بعد ما تتأكد. استخدم لوحة الاختبار والسجل.</p></li>
            <li><strong>المساعد</strong><p>فعّل قالب «Claude داخل واتساب»، واكتب مهمتك في محادثتك مع نفسك (ومعها صورة أو ملف)، رد «نعم» على الخطة.</p></li>
            <li><strong>التقارير</strong><p>قالب «تقرير مجدول»: غيّر المهمة، وغيّر <Copy>me</Copy> لرقم أو معرّف قروب.</p></li>
          </ol>
        </section>

        <section aria-labelledby="s8">
          <h2 id="s8">8. المزامنة والسرعة</h2>
          <p>على Hobby تشتغل المزامنة المجدولة مرة باليوم. الفلوات تشتغل أيضاً عند كل طلب من Claude. لو تبي ردود أسرع، اربط خدمة نبض مجانية (مثل cron-job.org) تستدعي كل 5 دقائق:</p>
          <Code label="رابط النبض">{`${origin}/api/cron/sync?key=YOUR_CRON_SECRET`}</Code>
        </section>

        <section aria-labelledby="s9">
          <h2 id="s9">9. رقم الأعمال الرسمي (اختياري)</h2>
          <ol className="steps">
            <li><strong>تطبيق Meta</strong><p>من developers.facebook.com أنشئ تطبيق Business وأضف له WhatsApp.</p></li>
            <li><strong>المتغيرات</strong><p>أضف <Copy>WHATSAPP_ACCESS_TOKEN</Copy> و <Copy>WHATSAPP_PHONE_NUMBER_ID</Copy> و <Copy>WHATSAPP_WABA_ID</Copy> و <Copy>META_APP_SECRET</Copy> و <Copy>WEBHOOK_VERIFY_TOKEN</Copy>.</p></li>
            <li><strong>Webhook</strong><p>WhatsApp ← Configuration: الرابط <Copy value={origin + "/api/webhook"}>/api/webhook</Copy> ورمز التحقق، واشترك في <Copy>messages</Copy>.</p></li>
            <li><strong>تحقق</strong><p>افتح <Copy value={origin + "/setup"}>/setup</Copy> يوريك وش ناقص.</p></li>
          </ol>
        </section>

        <section aria-labelledby="s10">
          <h2 id="s10">حل المشاكل</h2>
          <div className="risks">
            <div><h3>Wrong or missing MCP_SECRET</h3><p>الكلمة غلط أو المتصفح عبّأها تلقائياً بغيرها. جرّب نافذة Incognito، أو غيّر القيمة في Vercel واعمل Redeploy.</p></div>
            <div><h3>Claude ما يوصل للرابط</h3><p>غالباً حماية النشر شغالة، أو المفتاح ناقص من الرابط. اختبر الرابط بـ curl.</p></div>
            <div><h3>ما ترد الفلوات</h3><p>تأكد إن الفلو مفعّل وفي وضع تلقائي، وإن الإيقاف الشامل مطفي، وإن مفتاح الذكاء مضاف.</p></div>
          </div>
        </section>
      </main>
    </div>
  );
}
