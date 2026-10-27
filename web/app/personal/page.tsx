import { headers } from "next/headers";
import { LinkPanel } from "./LinkPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "ربط حسابك الشخصي", robots: { index: false } };

export default async function Personal() {
  const h = await headers();
  const origin = `https://${h.get("x-forwarded-host") ?? h.get("host") ?? "your-app.vercel.app"}`;
  return (
    <>
      <section>
          <h2>اربط حسابك الشخصي</h2>
          <p className="intro">
            نسختك على فيرسل تنضاف كـ "جهاز مرتبط" مثل واتساب ويب، ولك أكثر من رقم لو تبي. ما تبقى متصلة طول الوقت: تتصل لثواني مع كل طلب أو مزامنة، تسحب الرسائل الجديدة، تشغّل فلواتك، وتقفل.
          </p>
          <LinkPanel origin={origin} />
          <div className="note" style={{ marginTop: 32 }}>
            <p>
              هذي الطريقة غير رسمية. الاتصال من سيرفرات فيرسل بدل جوالك يرفع احتمال إن واتساب يقيّد الرقم، فاستخدمها لحسابك أنت وبحدود معقولة، وتجنب الإرسال الجماعي.
            </p>
          </div>
        </section>
    </>
  );
}
