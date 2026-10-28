"use client";

import type { Action } from "@/lib/flows/types";
import { Select } from "../Select";

export function ActionFields({ a, onChange, defaultPrompt, aiOn, cheapModel }: { a: Action; onChange: (a: Action) => void; defaultPrompt: string; aiOn: boolean; cheapModel?: string }) {
  switch (a.type) {
    case "reply":
      return (
        <>
          <textarea aria-label="نص الرد" value={a.text} onChange={(e) => onChange({ ...a, text: e.target.value })} placeholder="نص الرد" />
          <label className="sw small"><input type="checkbox" checked={a.quote} onChange={(e) => onChange({ ...a, quote: e.target.checked })} /> اقتبس رسالته</label>
        </>
      );
    case "send":
      return (
        <>
          <input dir="ltr" aria-label="إلى" value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value })} placeholder="me أو 966501234567" />
          <textarea aria-label="النص" value={a.text} onChange={(e) => onChange({ ...a, text: e.target.value })} placeholder="النص (تقدر تستخدم {{ai}} و{{text}})" />
        </>
      );
    case "react":
      return <input aria-label="الإيموجي" value={a.emoji} maxLength={8} style={{ width: 90 }} onChange={(e) => onChange({ ...a, emoji: e.target.value })} />;
    case "tag":
      return <input aria-label="الوسم" value={a.tag} maxLength={40} onChange={(e) => onChange({ ...a, tag: e.target.value })} placeholder="اسم الوسم" />;
    case "agent":
      return (
        <div>
          <textarea aria-label="تعليمات المهمة" value={a.prompt} onChange={(e) => onChange({ ...a, prompt: e.target.value })} placeholder="في فلو مجدول: اكتب المهمة هنا. في فلو الرسائل: تعليمات إضافية (اختياري)." />
          {cheapModel && (
            <label>المزود
              <Select value={a.provider ?? ""} onChange={(e) => onChange({ ...a, provider: (e.target.value || undefined) as "claude" | "cheap" | undefined })}>
                <option value="">الافتراضي</option><option value="claude">Anthropic</option><option value="cheap">متوافق مع OpenAI ({cheapModel})</option>
              </Select>
            </label>
          )}
          <label className="sw small"><input type="checkbox" checked={a.confirm} onChange={(e) => onChange({ ...a, confirm: e.target.checked })} /> اطلب تأكيدي (\"نعم\") قبل التنفيذ</label>
          <p className="hint">يستخدم الموصلات من صفحة قاعدة المعرفة. فقط رسائلك أنت (من رقمك) تُنفَّذ كمهام، وردّه يبدأ بـ 🤖 عشان ما يعيد نفسه.</p>
        </div>
      );
    case "delay": {
      const unit = a.minutes % 1440 === 0 ? 1440 : a.minutes % 60 === 0 ? 60 : 1;
      const set = (amount: number, u: number) => onChange({ ...a, minutes: Math.min(20160, Math.max(1, Math.round(amount) || 1) * u) });
      return (
        <>
          <div className="grid2">
            <label>المدة<input type="number" min={1} value={a.minutes / unit} onChange={(e) => set(Number(e.target.value), unit)} /></label>
            <label>الوحدة
              <Select value={unit} onChange={(e) => set(a.minutes / unit, Number(e.target.value))}>
                <option value={1}>دقيقة</option><option value={60}>ساعة</option><option value={1440}>يوم</option>
              </Select>
            </label>
          </div>
          <label className="sw small"><input type="checkbox" checked={a.cancelOnReply} onChange={(e) => onChange({ ...a, cancelOnReply: e.target.checked })} /> ألغِ الباقي لو الطرف الثاني كتب أثناء الانتظار</label>
          <p className="hint">الخطوات اللي بعد الانتظار تكمل عند أول مزامنة بعد انتهاء المدة، مو بالثانية. المزامنة تلقائية مرة باليوم، وأسرع لو فعّلت مزامنة متكررة. الحد الأقصى 14 يوم، وأي انتظار تأخر أكثر من 3 أيام عن موعده يُحذف بدل ما يرسل متأخراً.</p>
        </>
      );
    }
    case "webhook":
      return (
        <div className="grid2">
          <input dir="ltr" aria-label="الرابط" value={a.url} onChange={(e) => onChange({ ...a, url: e.target.value })} placeholder="https://…" />
          <Select aria-label="الطريقة" value={a.method} onChange={(e) => onChange({ ...a, method: e.target.value as "POST" | "GET" })}><option>POST</option><option>GET</option></Select>
        </div>
      );
    case "ai_reply":
    case "ai":
      return (
        <>
          {!aiOn && <p className="err small">أضف ANTHROPIC_API_KEY أو أي مزود متوافق مع OpenAI (AI_COMPAT_URL و AI_COMPAT_KEY و AI_COMPAT_MODEL: OpenAI أو DeepSeek أو Gemini أو OpenRouter أو Ollama…) في متغيرات فيرسل وأعد النشر.</p>}
          <textarea aria-label="تعليمات الذكاء الاصطناعي" value={a.prompt} onChange={(e) => onChange({ ...a, prompt: e.target.value })} placeholder={a.type === "ai_reply" ? `تعليمات للذكاء الاصطناعي. اتركها فاضية لهذا الافتراضي:\n${defaultPrompt}` : "وش تبي من الذكاء الاصطناعي؟ مثل: لخّص رسائل اليوم"} />
          <div className="grid2">
            <label>كم رسالة من المحادثة يقرأ<input type="number" min={1} max={60} value={a.context} onChange={(e) => onChange({ ...a, context: Number(e.target.value) })} /></label>
            {a.type === "ai" && (
              <label>يقرأ
                <Select value={a.scope} onChange={(e) => onChange({ ...a, scope: e.target.value as "chat" | "recent" })}><option value="chat">المحادثة الحالية</option><option value="recent">كل المحادثات الأخيرة</option></Select>
              </label>
            )}
            {a.type === "ai" && a.scope === "recent" && <label>آخر كم ساعة<input type="number" min={1} max={168} value={a.hours} onChange={(e) => onChange({ ...a, hours: Number(e.target.value) })} /></label>}
            <label>أقصى طول للجواب<input type="number" min={64} max={2000} value={a.maxTokens} onChange={(e) => onChange({ ...a, maxTokens: Number(e.target.value) })} /></label>
            {cheapModel && (
              <label>المزود
                <Select value={a.provider ?? ""} onChange={(e) => onChange({ ...a, provider: (e.target.value || undefined) as "claude" | "cheap" | undefined })}>
                  <option value="">الافتراضي</option><option value="claude">Anthropic</option><option value="cheap">متوافق مع OpenAI ({cheapModel})</option>
                </Select>
              </label>
            )}
            <label>موديل (اختياري)<input dir="ltr" value={a.model ?? ""} placeholder="الافتراضي" onChange={(e) => onChange({ ...a, model: e.target.value || undefined })} /></label>
          </div>
          {a.type === "ai_reply" && <label className="sw small"><input type="checkbox" checked={a.quote} onChange={(e) => onChange({ ...a, quote: e.target.checked })} /> اقتبس رسالته</label>}
          <p className="hint">{a.type === "ai_reply" ? "الذكاء الاصطناعي يقرأ المحادثة وما يشوف فيها تعليمات، فنص الغرباء ما يقدر يغيّر قواعده. وإذا ما شاف رد مناسب يتجاهل الرسالة." : "الناتج يتخزن في {{ai}} وتستخدمه في أكشن بعده."}</p>
        </>
      );
    default:
      return null;
  }
}
