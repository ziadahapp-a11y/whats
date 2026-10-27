"use client";

import { useState } from "react";

export function Code({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  }
  return (
    <>
      {label ? <p className="label">{label}</p> : null}
      <div className="code">
        <button type="button" className="copy" onClick={copy} aria-label="نسخ الأمر">
          {copied ? "تم النسخ" : "نسخ"}
        </button>
        <pre>
          <code>{children}</code>
        </pre>
      </div>
    </>
  );
}
