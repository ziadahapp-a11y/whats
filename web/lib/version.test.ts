import test from "node:test";
import assert from "node:assert/strict";
import { reportUrl, versionInfo } from "./version";

test("version info and bug report carry no secrets", () => {
  const v = versionInfo({ VERCEL_GIT_COMMIT_SHA: "abcdef1234567", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_REPO_OWNER: "o", VERCEL_GIT_REPO_SLUG: "r", MCP_SECRET: "should-never-appear-0123456789" });
  assert.equal(v.commit, "abcdef1");
  assert.equal(v.repo, "o/r");
  const url = reportUrl(v, { redis: true, ai: false }, "https://x.vercel.app");
  assert.ok(url.startsWith("https://github.com/"));
  assert.ok(!decodeURIComponent(url).includes("should-never-appear"));
  assert.ok(decodeURIComponent(url).includes("abcdef1"));
});
