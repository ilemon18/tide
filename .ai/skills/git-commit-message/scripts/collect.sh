#!/bin/bash
# Read-only snapshot of uncommitted work for the git-commit-message skill.
# Never runs add/commit/push/stash/checkout/reset; only Git read commands.
# Usage: bash collect.sh [diff cap lines, default 600]
set -uo pipefail

CAP="${1:-600}"

if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "NOT_A_GIT_REPO: $(pwd)"
  exit 0
fi
cd "$root" || { echo "CANNOT_CD: $root"; exit 0; }
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo .git)

echo "== REPO =="
echo "$root"

echo "== BRANCH =="
git branch --show-current 2>/dev/null || echo "(detached HEAD)"

echo "== IN PROGRESS =="
found=0
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e "$git_dir/$marker" ]; then echo "$marker"; found=1; fi
done
if [ -d "$git_dir/rebase-merge" ]; then echo "rebase-merge"; found=1; fi
if [ -d "$git_dir/rebase-apply" ]; then echo "rebase-apply"; found=1; fi
[ "$found" -eq 0 ] && echo "(none)"

echo "== STATUS (porcelain -uall) =="
git status --porcelain=v1 -uall 2>/dev/null

echo "== INDEX =="
if git diff --cached --quiet 2>/dev/null; then
  echo "STAGED: none (commit.sh will stage everything)"
else
  echo "STAGED: yes (commit.sh commits the index only; describe the staged diff)"
fi

echo "== STAGED STAT =="
git diff --cached --stat 2>/dev/null

echo "== UNSTAGED STAT =="
git diff --stat 2>/dev/null

echo "== RECENT SUBJECTS (20) =="
git log -20 --format='%s' 2>/dev/null

echo "== MESSAGE SAMPLE (last 5) =="
git log -5 --format='%B---' 2>/dev/null | head -60

echo "== STAGED DIFF (cap ${CAP} lines) =="
git diff --cached -U2 2>/dev/null | head -"$CAP"

echo "== UNSTAGED DIFF (cap ${CAP} lines) =="
git diff -U2 2>/dev/null | head -"$CAP"

echo "== UNTRACKED FILES (max 50) =="
git ls-files --others --exclude-standard 2>/dev/null | head -50

echo "== END =="
