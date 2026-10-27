import { Code } from "@/components/Code";
import { Mark, Seal } from "@/components/Mark";
import { Secrets } from "@/components/Secrets";

const REPO = "https://github.com/aliaaldihnayn-lab/whats-mcp";
const RAW = "https://raw.githubusercontent.com/aliaaldihnayn-lab/whats-mcp/main";

const DEPLOY_URL =
  "https://vercel.com/new/clone?" +
  new URLSearchParams({
    "repository-url": REPO,
    "root-directory": "web",
    "project-name": "whats-mcp-cloud",
    env: "MCP_SECRET,CRON_SECRET",
    envDescription: "Two long random strings you choose (24+ characters). Meta keys for the official mode can be added later.",
    envLink: `${REPO}/blob/main/web/README.md`,
  }).toString();

const FEATURES: { title: string; text: string; items?: string[]; badge?: string }[] = [
  { title: "اقرأ وابحث", text: "المساعد يقرأ محادثاتك وقروباتك ويدوّر فيها ويلخّص لك اللي فاتك.", items: ["قراءة المحادثات والقروبات", "بحث في كل الرسائل", "التحقق إن الرقم على واتساب"] },
  { title: "أرسل بموافقتك", text: "نص، صور، ملفات، تفاعلات وتعليم كمقروء، وكل رسالة تنرسل بعد ما تؤكدها أنت.", items: ["نص وميديا", "ردود وتفاعلات", "تعليم كمقروء"] },
  { title: "أكثر من رقم", text: "اربط لين 10 أرقام خاصة على نفس النسخة، وكل رقم له جلسته ورسائله لحاله.", badge: "جديد" },
  { title: "مفتاح لكل جهاز", text: "أنشئ مفتاح لكل جهاز أو شخص، للقراءة فقط أو للقراءة والإرسال، ومحدد بأرقام معينة. تلغيه بضغطة.", badge: "جديد" },
  { title: "الربط من رابط واحد", text: "الصق رابط واحد في Claude أو Cursor وخلاص. بدون ملفات إعداد.", badge: "جديد" },
  { title: "صندوق الوارد", text: "لوحة تحكم تتصفح فيها الرسائل، ترد، تتفاعل، تعلّم مقروء، وتعتمد المسودات اللي جهزتها الفلوات.", badge: "جديد" },
  { title: "فلوات (أتمتة)", text: "اضبط قواعد: لو وصلت رسالة بهذا الشرط سوّ كذا. شروط وأكشنات كثيرة وجدولة بالساعة، مع وضع تجربة قبل التشغيل.", items: ["ردود على كلمات مفتاحية", "خارج الدوام", "وسوم وتفاعلات وWebhook", "أوضاع: مسودة / تلقائي / تجربة"], badge: "جديد" },
  { title: "Claude يرد على عملائك", text: "كل رسالة تنقرأ ويكتب لها Claude رد بلهجتك. تعتمده بنفسك أو يرسله تلقائياً مع حدود أمان.", badge: "جديد" },
  { title: "قاعدة معرفة", text: "أضف رابط الهلب سنتر أو مقالات أو ملفات PDF وWord وMarkdown، وClaude يجاوب منها فقط ولا يخترع.", badge: "جديد" },
  { title: "Claude داخل واتساب", text: "اكتب مهمتك لنفسك (ومعها صورة أو أي ملف: PDF، Word، نص…)، يرد بالخطة، تقول «نعم» وينفذها بالأدوات اللي ربطتها: متجر، تصميم، جدولة نشر…", badge: "جديد" },
  { title: "تقارير مجدولة", text: "كل صباح يوصلك على رقمك أو في قروب تحدده تقرير مبيعات أو ملخص رسائل، بدون ما تفتح Claude.", badge: "جديد" },
  { title: "الربط الرسمي", text: "لرقم الأعمال عبر Cloud API من Meta: قوالب، أزرار، ونافذة الـ24 ساعة. مع نفس الفلوات والإنبوكس." },
];

export default function Home() {
  return (
    <>
      <div className="wrap">
        <header className="top">
          <a className="mark" href="/">
            <Mark />
            واتساب MCP
          </a>
          <nav aria-label="أقسام الصفحة">
            <a href="#features">الخصائص</a>
            <a href="/guide">دليل الإعداد</a>
            <a href="#start">ابدأ</a>
            <a href="#modes">الطرق</a>
            <a href="#safety">الأمان</a>
            <a href={REPO}>الكود</a>
            <a className="btn solid" href="/personal">افتح النظام</a>
          </nav>
        </header>

        <main>
          <div className="hero">
            <div>
              <h1>Claude داخل واتساب</h1>
              <p className="lede">
                يقرأ رسائلك، يرد عن عملائك من هلب سنترك، وينفذ مهامك ويرسل لك التقارير. كل هذا من واتساب نفسه، بدون ما تفتح Claude.
              </p>
              <div className="actions">
                <a className="btn solid" href="/personal">افتح النظام</a>
                <a className="btn ghost" href={DEPLOY_URL}>انشر نسختك مجاناً</a>
                <a className="btn ghost" href="/guide">دليل الإعداد الكامل</a>
              </div>
            </div>

            <div className="chat" aria-label="مثال: مهمة تنرسل من واتساب">
              <div className="who">محادثتك مع نفسك</div>
              <div className="bubble me">
                منتج جديد: قميص قطن، 120 ريال
                <time>9:41 ص</time>
              </div>
              <div className="bubble ai">
                🤖 الخطة: أضيفه للمتجر، أصمم له بوستين، وأجدولهم الخميس. أنفذ؟
                <time>9:41 ص</time>
              </div>
              <div className="bubble me">
                نعم
                <time>9:42 ص</time>
              </div>
              <div className="tool">shop.create_product · design.make_posts · scheduler.queue</div>
              <div className="bubble ai">
                🤖 تم. المنتج منشور، والبوستات مجدولة الخميس 7 مساءً.
                <time>9:43 ص</time>
              </div>
            </div>
          </div>

          <section id="features" aria-labelledby="features-h">
            <h2 id="features-h">كل اللي يسويه</h2>
            <p className="intro">من قراءة بسيطة لين مساعد ينفذ لك مهام كاملة. تستخدم اللي تحتاجه وتترك الباقي.</p>
            <div className="features">
              {FEATURES.map((f) => (
                <div className="feature" key={f.title}>
                  <h3>
                    {f.title}
                    {f.badge && <span className="badge">{f.badge}</span>}
                  </h3>
                  <p>{f.text}</p>
                  {f.items && (
                    <ul>
                      {f.items.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section id="start" aria-labelledby="start-h">
            <div className="mode">
              <div>
                <h2 id="start-h">ابدأ في 5 خطوات بسيطة</h2>
                <p className="intro">نسخة خاصة فيك على Vercel. مجانية، وتشتغل بدون جهازك، وبياناتك عندك.</p>
                <ol className="steps">
                  <li>
                    <strong>ولّد كلمتي السر</strong>
                    <p>بالزر تحت. انسخهم واحفظهم، تحتاجهم في الخطوة الثانية.</p>
                  </li>
                  <li>
                    <strong>اضغط «انشر نسختك»</strong>
                    <p>سجّل في Vercel بحساب GitHub، والصق كلمتي السر. قاعدة البيانات تضيفها بعد النشر (الخطوة تحت).</p>
                  </li>
                  <li>
                    <strong>افتح النظام واربط رقمك</strong>
                    <p>
                      افتح <code>/personal</code> في نسختك، اكتب رقمك، وأدخل الرمز في واتساب من الأجهزة المرتبطة.
                    </p>
                  </li>
                  <li>
                    <strong>أضف مفتاح الذكاء</strong>
                    <p>
                      DeepSeek الأرخص، أو Claude. التفاصيل في <a href="/guide#s3">الدليل</a>. وتختبره بزر واحد من لوحة التحكم.
                    </p>
                  </li>
                  <li>
                    <strong>الصق الرابط في Claude</strong>
                    <p>من لوحة التحكم أنشئ مفتاح جهاز وانسخ الرابط الجاهز.</p>
                  </li>
                </ol>
                <p>
                  تحتاج تفاصيل أكثر؟ <a href="/guide">دليل الإعداد الكامل</a>.
                </p>
              </div>
              <div>
                <Secrets />
                <p>
                  <a className="btn solid" href={DEPLOY_URL}>انشر نسختك على Vercel</a>{" "}
                  <a className="btn ghost" href="/personal">افتح النظام</a>
                </p>
                <Code label="الرابط الجاهز لمساعدك (تنسخه من لوحة التحكم)">{`https://YOUR-APP.vercel.app/api/personal/mcp?key=wmk_…`}</Code>
                <div className="note">
                  <p>
                    مع كل طلب تتصل النسخة لثواني وتسحب الجديد، فالطلب ياخذ 5 إلى 20 ثانية. على Vercel المجاني تشتغل المزامنة المجدولة مرة باليوم، ولردود أسرع اربط خدمة نبض خارجية (التفاصيل في الدليل).
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section id="modes" aria-labelledby="modes-h">
            <h2 id="modes-h">ثلاث طرق للربط</h2>
            <p className="intro">Meta ما تسمح رسمياً بقراءة الحسابات الشخصية، فلحسابك الشخصي يُربط جهازك كـ «جهاز مرتبط» مثل واتساب ويب. ولرقم الأعمال فيه ربط رسمي.</p>
            <div className="table-scroll">
              <table className="compare">
                <thead>
                  <tr>
                    <td />
                    <th scope="col">شخصي على Vercel <span className="badge">الأسهل</span></th>
                    <th scope="col">شخصي على جهازك</th>
                    <th scope="col">
                      رسمي (رقم أعمال)
                      <span className="seal">
                        <Seal />
                        Cloud API من Meta
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">الحساب</th>
                    <td>رقمك الشخصي، حتى 10 أرقام</td>
                    <td>رقمك الشخصي</td>
                    <td>رقم أعمال مسجّل في Meta</td>
                  </tr>
                  <tr>
                    <th scope="row">يقرأ</th>
                    <td>المحادثات والقروبات والرسائل الجديدة</td>
                    <td>كل شي مع السجل القديم</td>
                    <td>الرسائل بعد الربط</td>
                  </tr>
                  <tr>
                    <th scope="row">الفلوات وClaude</th>
                    <td>نعم</td>
                    <td>لا</td>
                    <td>نعم</td>
                  </tr>
                  <tr>
                    <th scope="row">الأدوات</th>
                    <td>12</td>
                    <td>45 (قروبات، تصويتات، خصوصية…)</td>
                    <td>12 (قوالب، أزرار…)</td>
                  </tr>
                  <tr>
                    <th scope="row">يشتغل</th>
                    <td>دائماً، بدون جهازك</td>
                    <td>طالما جهازك شغال</td>
                    <td>دائماً</td>
                  </tr>
                  <tr>
                    <th scope="row">التكلفة</th>
                    <td>مجاني (Claude حسب الاستخدام)</td>
                    <td>مجاني</td>
                    <td>Meta تحاسب على القوالب</td>
                  </tr>
                  <tr>
                    <th scope="row">المخاطرة</th>
                    <td>غير رسمي، استخدمه بحدود معقولة</td>
                    <td>غير رسمي</td>
                    <td>رسمي، بشرط تلتزم بسياسات Meta</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>على جهازك (نسخة Go)</h3>
            <p>برنامج واحد يشتغل بالخلفية ويحفظ الرسائل عندك. بعد التثبيت افتح <code>127.0.0.1:8765/pair</code> وامسح الرمز من واتساب.</p>
            <Code label="ماك ولينكس">{`curl -fsSL ${RAW}/scripts/install.sh | sh`}</Code>
            <Code label="ويندوز (PowerShell)">{`irm ${RAW}/scripts/install.ps1 | iex`}</Code>
            <Code label="Claude Code و Cursor">{`{ "mcpServers": { "whatsapp": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }`}</Code>

            <h3>الربط الرسمي لرقم الأعمال</h3>
            <p>
              أنشئ تطبيق Business من <a href="https://developers.facebook.com/apps">developers.facebook.com</a> وأضف له WhatsApp، وانشر نسختك، ثم ضع في Vercel المفاتيح التالية، ووصّل الـ Webhook على <code>/api/webhook</code>. صفحة <code>/setup</code> توريك وش ناقص.
            </p>
            <div className="envs">
              <code>WHATSAPP_ACCESS_TOKEN</code>
              <span>مفتاح System User دائم</span>
              <code>WHATSAPP_PHONE_NUMBER_ID</code>
              <span>معرّف الرقم</span>
              <code>WHATSAPP_WABA_ID</code>
              <span>معرّف حساب الأعمال</span>
              <code>META_APP_SECRET</code>
              <span>يتحقق إن الرسائل من Meta</span>
              <code>WEBHOOK_VERIFY_TOKEN</code>
              <span>أي نص تختاره</span>
            </div>
          </section>

          <section id="safety" aria-labelledby="safety-h">
            <h2 id="safety-h">الأمان</h2>
            <p className="intro">المساعد يتعامل مع رسائل الناس، فبنينا الحماية من البداية.</p>
            <div className="risks">
              <div>
                <h3>رسائل الغرباء ما تأمر Claude</h3>
                <p>أي رسالة تصل تُعامل كبيانات فقط. ولا ينفذ مهمة إلا لو جات من رقمك أنت، ويطلب تأكيدك «نعم» قبل ما يستخدم الأدوات.</p>
              </div>
              <div>
                <h3>تتحكم بكل شي</h3>
                <p>الفلوات تبدأ كمسودات تعتمدها بنفسك، وفيها حدود للساعة ولكل محادثة وللتكلفة اليومية، وزر إيقاف شامل.</p>
              </div>
              <div>
                <h3>بياناتك عندك</h3>
                <p>كل شي في حسابك على Vercel وقاعدة بياناتك. مفاتيح الأجهزة تنحفظ مشفرة بالبصمة فقط، وتظهر لك مرة وحدة. المشروع مفتوح المصدر (MIT) وما له علاقة بـ Meta أو واتساب.</p>
              </div>
            </div>
          </section>
        </main>
      </div>

      <footer>
        <div className="wrap">
          مبني على شغل <a href="https://github.com/lharries/whatsapp-mcp">Luke Harries</a> و{" "}
          <a href="https://github.com/Sealjay/mcp-whatsapp">Chris Lloyd-Jones</a> ومكتبتي <a href="https://github.com/tulir/whatsmeow">whatsmeow</a> و{" "}
          <a href="https://github.com/WhiskeySockets/Baileys">Baileys</a>. <a href={REPO}>الكود على GitHub</a>.
        </div>
      </footer>
    </>
  );
}
