"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Mark } from "@/components/Mark";
import { SecretGate, type Status } from "./shared";

const ITEMS = [
  { href: "/personal/overview", label: "نظرة عامة", icon: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z" },
  { href: "/personal/inbox", label: "صندوق الوارد", icon: "M4 5h16v11H8l-4 4V5z" },
  { href: "/personal/flows", label: "الفلوات", icon: "M13 2L4 14h7l-1 8 9-12h-7l1-8z" },
  { href: "/personal/knowledge", label: "قاعدة المعرفة", icon: "M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4zm3 4h8M8 12h8" },
  { href: "/personal", label: "الأرقام والمفاتيح", icon: "M12 3a4 4 0 100 8 4 4 0 000-8zm-8 18a8 8 0 0116 0" },
] as const;

function isActive(path: string, href: string) {
  return href === "/personal" ? path === href : path === href || path.startsWith(`${href}/`);
}

function Shell({ status, children }: { status: Status; children: ReactNode }) {
  const path = usePathname();
  const paired = status.accounts.filter((a) => a.paired).length;
  return (
    <div className="app">
      <aside className="app-side">
        <Link className="mark" href="/">
          <Mark />
          واتساب MCP
        </Link>
        <nav className="app-nav" aria-label="أقسام لوحة التحكم">
          {ITEMS.map((it) => (
            <Link key={it.href} href={it.href} prefetch aria-current={isActive(path, it.href) ? "page" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={it.icon} />
              </svg>
              <span>{it.label}</span>
            </Link>
          ))}
        </nav>
        <div className="app-foot">
          <span className={`dot ${paired ? "on" : "off"}`} aria-hidden="true" />
          {paired ? `${paired} رقم مربوط` : "لا يوجد رقم مربوط"}
          {status.flowsPaused && <span className="tag">الفلوات متوقفة</span>}
        </div>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  );
}

export default function PersonalLayout({ children }: { children: ReactNode }) {
  return <SecretGate>{(_secret, status) => <Shell status={status}>{children}</Shell>}</SecretGate>;
}
