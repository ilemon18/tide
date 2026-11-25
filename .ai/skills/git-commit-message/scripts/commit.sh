#!/bin/bash
# Commit exactly one message line for the git-commit-message skill.
# The subject is passed as a single -m, so the generated body is never committed.
# Never pushes, amends, bypasses hooks or forces anything.
# Usage: bash commit.sh "<subject>"
set -uo pipefail

subject="${1-}"
if [ -z "$subject" ]; then
  echo 'MISSING_SUBJECT: usage: commit.sh "<subject>"'
  exit 2
fi
case "$subject" in
  *$'\n'*|*$'\r'*)
    echo "SUBJECT_MUST_BE_A_SINGLE_LINE"
    exit 2
    ;;
esac

if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "NOT_A_GIT_REPO: $(pwd)"
  exit 0
fi
cd "$root" || { echo "CANNOT_CD: $root"; exit 1; }
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo .git)

for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -e "$git_dir/$marker" ]; then
    echo "IN_PROGRESS: $marker — finish or abort it before committing"
    exit 3
  fi
done
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
  echo "IN_PROGRESS: rebase — finish or abort it before committing"
  exit 3
fi

# Honor an existing partial index; otherwise stage the whole work tree (ignored files stay ignored).
if git diff --cached --quiet 2>/dev/null; then
  if ! git add -A; then
    echo "ADD_FAILED: nothing was committed"
    exit 4
  fi
fi

if git diff --cached --quiet 2>/dev/null; then
  echo "NOTHING_TO_COMMIT"
  exit 0
fi

if git commit -m "$subject"; then
  echo "== COMMITTED =="
  git log -1 --format='%h %s'
  echo "== REMAINING =="
  remaining=$(git status --porcelain=v1 -uall 2>/dev/null)
  if [ -z "$remaining" ]; then
    echo "(clean)"
  else
    echo "$remaining"
  fi
else
  status=$?
  echo "== COMMIT_FAILED (exit $status) =="
  echo "The index is left staged; fix the failure and rerun or report it. Do not use --no-verify."
  exit "$status"
fi
