"use client";

import { useState } from "react";

async function put(text: string, done: () => void) {
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    /* clipboard blocked: the text stays selectable */
  }
}

/** A value inside a sentence: one tap copies it. */
export function Copy({ children, value }: { children: string; value?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className={`cp${ok ? " ok" : ""}`} dir="ltr" title="اضغط للنسخ" onClick={() => put(value ?? children, () => (setOk(true), setTimeout(() => setOk(false), 1400)))}>
      <span>{children}</span>
      <i aria-hidden="true">{ok ? "✓" : "⧉"}</i>
      <span className="sr">{ok ? "تم النسخ" : "نسخ"}</span>
    </button>
  );
}

/** A labelled value to paste into a form, with a copy button. */
export function Field({ name, value, note }: { name: string; value: string; note?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="field">
      <div className="fname">
        <b>{name}</b>
        {note ? <small>{note}</small> : null}
      </div>
      <code dir="ltr">{value}</code>
      <button type="button" className="copy" onClick={() => put(value, () => (setOk(true), setTimeout(() => setOk(false), 1400)))}>
        {ok ? "تم النسخ" : "انسخ"}
      </button>
    </div>
  );
}
