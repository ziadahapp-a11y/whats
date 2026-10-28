"use client";

import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A drop-in for the native <select>: same <option> children, and onChange gets { target: { value } },
 * so a page swaps the tag and keeps its handler. The menu is the Ziadah dropdown: white panel, soft shadow,
 * a check on the chosen row. Keyboard: arrows, Home/End, Enter or Space to pick, Escape, type to jump.
 */
export type SelectChange = { target: { value: string } };

type Opt = { value: string; label: ReactNode; text: string; disabled: boolean };

function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (el.type === Fragment) collect(el.props.children, out);
    else if (el.type === "option") {
      const text = Children.toArray(el.props.children).join("");
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : text, label: el.props.children, text, disabled: !!el.props.disabled });
    }
  });
  return out;
}

type Place = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

export function Select({
  value,
  onChange,
  children,
  disabled,
  className,
  id,
  title,
  "aria-label": ariaLabel,
}: {
  value: string | number;
  onChange: (e: SelectChange) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const opts = collect(children);
  const cur = opts.findIndex((o) => o.value === String(value));
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ s: "", t: 0 });
  const uid = useId();

  const firstEnabled = () => Math.max(0, opts.findIndex((o) => !o.disabled));
  const lastEnabled = () => {
    for (let i = opts.length - 1; i >= 0; i--) if (!opts[i].disabled) return i;
    return 0;
  };

  const measure = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const flip = below < 200 && r.top > below;
    const maxHeight = Math.max(120, Math.min(280, (flip ? r.top : below) - 12));
    setPlace({ left: r.left, width: r.width, maxHeight, ...(flip ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  }, []);

  const show = () => {
    if (disabled || !opts.length) return;
    setHot(cur >= 0 ? cur : firstEnabled());
    setOpen(true);
  };

  const choose = (i: number) => {
    const o = opts[i];
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== String(value)) onChange({ target: { value: o.value } });
    btn.current?.focus();
  };

  const move = (d: number) => {
    let i = hot;
    for (let n = 0; n < opts.length; n++) {
      i = (i + d + opts.length) % opts.length;
      if (!opts[i].disabled) break;
    }
    setHot(i);
  };

  useEffect(() => {
    if (!open) return;
    measure();
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-o${hot}`)?.scrollIntoView({ block: "nearest" });
  }, [open, hot, uid]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (k === "Escape") (e.preventDefault(), setOpen(false));
    else if (k === "ArrowDown") (e.preventDefault(), move(1));
    else if (k === "ArrowUp") (e.preventDefault(), move(-1));
    else if (k === "Home") (e.preventDefault(), setHot(firstEnabled()));
    else if (k === "End") (e.preventDefault(), setHot(lastEnabled()));
    else if (k === "Enter" || k === " ") (e.preventDefault(), choose(hot));
    else if (k === "Tab") setOpen(false);
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      const now = Date.now();
      const t = typed.current;
      t.s = now - t.t < 700 ? t.s + k.toLowerCase() : k.toLowerCase();
      t.t = now;
      const i = opts.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(t.s));
      if (i >= 0) setHot(i);
    }
  };

  const shown = cur >= 0 ? opts[cur] : undefined;
  const root = open ? (btn.current?.closest(".app") ?? document.body) : null;

  return (
    <span className={`sel${className ? ` ${className}` : ""}`}>
      <button
        ref={btn}
        type="button"
        role="combobox"
        className="sel-btn"
        id={id}
        title={title}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${uid}-l` : undefined}
        aria-activedescendant={open ? `${uid}-o${hot}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="sel-val">{shown ? shown.label : " "}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open &&
        place &&
        root &&
        createPortal(
          <ul
            ref={list}
            id={`${uid}-l`}
            role="listbox"
            aria-label={ariaLabel}
            className="sel-list"
            style={{ left: place.left, top: place.top, bottom: place.bottom, minWidth: place.width, maxHeight: place.maxHeight }}
          >
            {opts.map((o, i) => (
              <li
                key={`${o.value}-${i}`}
                id={`${uid}-o${i}`}
                role="option"
                aria-selected={i === cur}
                aria-disabled={o.disabled || undefined}
                data-hot={i === hot ? "" : undefined}
                onPointerEnter={() => !o.disabled && setHot(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span>{o.label}</span>
                {i === cur && (
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </li>
            ))}
          </ul>,
          root,
        )}
    </span>
  );
}
