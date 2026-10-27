"use client";

import { useState } from "react";

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Makes two random passwords in the browser (nothing is sent anywhere). */
export function Secrets() {
  const [v, setV] = useState<{ mcp: string; cron: string } | null>(null);
  const [copied, setCopied] = useState("");
  async function copy(name: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(name);
      setTimeout(() => setCopied(""), 1500);
    } catch {}
  }
  return (
    <div className="note">
      <p>
        <strong>ولّد كلمتي السر بضغطة:</strong> تنولد في متصفحك فقط، وما تنرسل لأي مكان.
      </p>
      <p>
        <button type="button" className="btn solid" onClick={() => setV({ mcp: hex(24), cron: hex(24) })}>
          {v ? "ولّد من جديد" : "ولّد كلمتي السر"}
        </button>
      </p>
      {v && (
        <div className="envs">
          <code>MCP_SECRET</code>
          <span dir="ltr">
            <code>{v.mcp}</code> <button type="button" onClick={() => copy("m", v.mcp)}>{copied === "m" ? "تم النسخ" : "نسخ"}</button>
          </span>
          <code>CRON_SECRET</code>
          <span dir="ltr">
            <code>{v.cron}</code> <button type="button" onClick={() => copy("c", v.cron)}>{copied === "c" ? "تم النسخ" : "نسخ"}</button>
          </span>
        </div>
      )}
    </div>
  );
}
