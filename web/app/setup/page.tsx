import { headers } from "next/headers";
import { configChecks } from "@/lib/config";
import { isAuthorized } from "@/lib/auth";
import { runtime } from "@/lib/runtime";
import { Mark } from "@/components/Mark";
import { Code } from "@/components/Code";

export const dynamic = "force-dynamic";
export const metadata = { title: "إعداد الربط الرسمي", robots: { index: false } };

type Live = { label: string; ok: boolean; detail: string };

async function liveChecks(): Promise<Live[]> {
  const { graph, store } = runtime();
  const out: Live[] = [];
  try {
    const p: any = await graph.phoneInfo();
    out.push({ label: "الاتصال بـ Meta", ok: true, detail: `${p.verified_name ?? ""} ${p.display_phone_number ?? ""}، الجودة: ${p.quality_rating ?? "غير معروف"}` });
  } catch (e) {
    out.push({ label: "الاتصال بـ Meta", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  try {
    const convs = await store.conversations(100);
    out.push({ label: "قاعدة البيانات", ok: true, detail: `${convs.length} محادثة محفوظة` });
  } catch (e) {
    out.push({ label: "قاعدة البيانات", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

export default async function Setup({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { cfg } = runtime();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "your-app.vercel.app";
  const origin = `https://${host}`;
  const checks = configChecks(cfg);
  const ready = checks.every((c) => c.ok);
  const { key } = await searchParams;
  const authed = !!key && isAuthorized(new Request(`${origin}/?key=${encodeURIComponent(key)}`), cfg.mcpSecret);
  const live = authed ? await liveChecks() : [];

  return (
    <div className="wrap">
      <header className="top">
        <a className="mark" href="/">
          <Mark />
          واتساب MCP
        </a>
      </header>
      <main>
        <section style={{ borderTop: 0, paddingTop: 16 }}>
          <h2>إعداد الربط الرسمي</h2>
          <p className="intro">
            {ready ? "كل الإعدادات موجودة. باقي توصل الـ Webhook عند Meta وتضيف السيرفر لمساعدك." : "فيه إعدادات ناقصة. أضفها من Settings ← Environment Variables في مشروعك على فيرسل، ثم أعد النشر."}
          </p>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.key}>
                <span className={`st ${c.ok ? "ok" : "no"}`} aria-label={c.ok ? "موجود" : "ناقص"}>
                  {c.ok ? "✓" : "✗"}
                </span>
                <div>
                  {c.label} <code>{c.key}</code>
                  {!c.ok && <small>{c.hint}</small>}
                </div>
              </li>
            ))}
          </ul>

          <h3>رابط الـ Webhook</h3>
          <p>انسخه في تطبيق Meta: WhatsApp ← Configuration ← Callback URL، واشترك في messages.</p>
          <Code>{`${origin}/api/webhook`}</Code>

          <h3>رابط الـ MCP</h3>
          <p>يحتاج كلمة السر MCP_SECRET، إما في ترويسة Authorization أو في الرابط نفسه للبرامج اللي ما تقبل ترويسات.</p>
          <Code>{`{ "mcpServers": { "whatsapp-business": {
    "type": "http",
    "url": "${origin}/api/mcp",
    "headers": { "Authorization": "Bearer YOUR_MCP_SECRET" }
} } }`}</Code>
          <Code label="أو كرابط واحد">{`${origin}/api/mcp?key=YOUR_MCP_SECRET`}</Code>

          <h3>فحص مباشر</h3>
          {authed ? (
            <ul className="checks">
              {live.map((c) => (
                <li key={c.label}>
                  <span className={`st ${c.ok ? "ok" : "no"}`}>{c.ok ? "✓" : "✗"}</span>
                  <div>
                    {c.label}
                    <small>{c.detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="note">
              <p>
                عشان تفحص الاتصال بـ Meta وقاعدة البيانات، افتح هذي الصفحة مع كلمة السر: <code>/setup?key=YOUR_MCP_SECRET</code>
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
