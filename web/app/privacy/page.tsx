import { Mark } from "@/components/Mark";

export const metadata = { title: "سياسة الخصوصية | واتساب MCP", description: "ما يجمعه النظام وكيف يستخدم بيانات واتساب وتقويم Google." };

export default function Privacy() {
  return (
    <div className="wrap">
      <header className="top">
        <a className="mark" href="/">
          <Mark />
          واتساب MCP
        </a>
        <nav aria-label="روابط">
          <a href="/">الرئيسية</a>
        </nav>
      </header>
      <main>
        <section style={{ borderTop: 0 }}>
          <h1>سياسة الخصوصية</h1>
          <p className="intro">هذا النظام أداة داخلية يشغلها صاحب الحساب لخدمة عملائه على واتساب. هذي الصفحة توضح وش البيانات اللي يتعامل معها وكيف.</p>
        </section>
        <section>
          <h2>الرسائل</h2>
          <p>الرسائل اللي توصل الرقم الرسمي أو تنرسل منه تنحفظ في قاعدة بيانات المشروع عشان تظهر في صندوق الوارد وتشتغل عليها الردود التلقائية. ما تنباع ولا تنشارك مع أي طرف، وتنرسل لمزود الذكاء الاصطناعي فقط بالقدر اللازم لكتابة الرد.</p>
        </section>
        <section>
          <h2>تقويم Google</h2>
          <p>إذا ربط صاحب الحساب تقويمه، النظام يقرأ الأوقات المشغولة (بدون تفاصيل المواعيد) عشان يقترح أوقات فاضية، وينشئ مواعيد الاجتماعات اللي يحجزها العملاء مع دعوة على إيميلهم. ما يقرأ محتوى المواعيد الثانية ولا يعدلها ولا يحذفها. استخدام بيانات Google يلتزم بـ <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>، بما فيها شروط Limited Use.</p>
          <p>تقدر تلغي الوصول في أي وقت من صفحة قاعدة المعرفة (فصل) أو من <a href="https://myaccount.google.com/permissions">إعدادات حسابك في Google</a>.</p>
        </section>
        <section>
          <h2>البيانات اللي نطلبها من العملاء</h2>
          <p>نطلب الإيميل فقط عند الحاجة (مثل دعوة اجتماع). ما نطلب كلمات مرور أبداً.</p>
        </section>
        <section>
          <h2>التواصل</h2>
          <p>لأي سؤال عن الخصوصية أو طلب حذف بيانات، راسلنا على نفس رقم واتساب.</p>
        </section>
      </main>
    </div>
  );
}
