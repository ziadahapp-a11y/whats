import type { ReactNode } from "react";

const PATH = {
  bad: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 8v5M12 16h.01",
  lock: "M7 11V8a5 5 0 0110 0v3M6 11h12v10H6z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
};

/**
 * The Ziadah state card: a round icon, a title, one muted line and up to two buttons.
 * `bad` is for a failed load, `lock` for something the setup does not include, `info` for an empty page.
 */
export function State({ tone = "info", title, children, actions }: { tone?: keyof typeof PATH; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`state ${tone === "bad" ? "bad" : ""}`} role={tone === "bad" ? "alert" : undefined}>
      <span className="state-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d={PATH[tone]} />
        </svg>
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}
