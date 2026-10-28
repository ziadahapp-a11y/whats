#!/usr/bin/env bash
# Copies this repo's committed tree (HEAD) into the repo a Vercel project deploys from, as one normal
# commit on its main branch (no force push). The push makes Vercel redeploy.
#
#   scripts/sync-deploy-repo.sh [TARGET_REPO_URL] [BRANCH]
#
# Default target: https://github.com/ziadahapp-a11y/whats (the project behind whats-delta.vercel.app).
# SYNC_NOTE, if set, is appended to the commit message (for trailers).
set -euo pipefail

TARGET="${1:-https://github.com/ziadahapp-a11y/whats}"
BRANCH="${2:-main}"

cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "warning: uncommitted changes are not copied, only HEAD" >&2

SHA="$(git rev-parse --short HEAD)"
NAME="$(git remote get-url origin | sed -E 's#(\.git)?/?$##; s#.*github\.com[:/]##')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --quiet --depth 1 --branch "$BRANCH" "$TARGET" "$TMP/t"

# swap the target's tracked files for this commit's tree
git -C "$TMP/t" rm -r -q --ignore-unmatch . > /dev/null
git archive HEAD | tar -x -C "$TMP/t"
git -C "$TMP/t" add -A

if git -C "$TMP/t" diff --cached --quiet; then
  echo "already in sync with $NAME $SHA"
  exit 0
fi

git -C "$TMP/t" commit -q -m "Sync with $NAME $SHA${SYNC_NOTE:+

$SYNC_NOTE}"
git -C "$TMP/t" push origin "$BRANCH"
echo "synced $NAME $SHA to $TARGET ($BRANCH). Check /api/version on the deployment for the new commit."
