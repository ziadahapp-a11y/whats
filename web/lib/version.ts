// What this deployment is running. Contains nothing secret: it is shown in the dashboard,
// served publicly at /api/version, and attached to bug reports.

export const REPO = "aliaaldihnayn-lab/whats-mcp";

export function versionInfo(env: Record<string, string | undefined> = process.env) {
  const sha = env.VERCEL_GIT_COMMIT_SHA ?? "";
  return {
    repo: env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null,
    commit: sha ? sha.slice(0, 7) : null,
    branch: env.VERCEL_GIT_COMMIT_REF ?? null,
    env: env.VERCEL_ENV ?? "local",
  };
}

/** A pre-filled GitHub issue on the main repo: customers press one button, you get version + health, never secrets. */
export function reportUrl(v: ReturnType<typeof versionInfo>, health: Record<string, boolean | string | null | undefined>, origin: string) {
  const lines = [
    "## الوصف",
    "(اكتب المشكلة أو الاقتراح هنا)",
    "",
    "## معلومات النسخة (تلقائي، بدون أسرار)",
    `- الإصدار: ${v.commit ?? "غير معروف"} (${v.branch ?? "?"}، المستودع: ${v.repo ?? "غير معروف"})`,
    `- النظام: ${origin}`,
    ...Object.entries(health).map(([k, x]) => `- ${k}: ${typeof x === "boolean" ? (x ? "نعم" : "لا") : (x ?? "-")}`),
  ];
  const q = new URLSearchParams({ title: "ملاحظة من عميل: ", body: lines.join("\n"), labels: "customer" });
  return `https://github.com/${REPO}/issues/new?${q}`;
}
