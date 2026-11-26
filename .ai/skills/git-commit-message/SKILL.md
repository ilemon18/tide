---
name: git-commit-message
description: Generate an English commit message from uncommitted changes and commit only its subject line, showing the body for reference. Use when the user asks to commit, write a commit message, 提交代码 or 生成提交信息. Never pushes, and stops instead of bypassing hooks, merges or rebases.
---

# Subject-only commit

Produce a clean English commit message and commit exactly its first line. The body is a preview: show it in
the reply, never write it to history. This is the only Tide skill allowed to write Git state, and only
through its two scripts.

## Rules

- Commit the subject only with `bash .ai/skills/git-commit-message/scripts/commit.sh "<subject>"`; it passes
  one `-m`, so bullets, `Refs:` and `BREAKING CHANGE:` stay in the reply. Anything history must keep belongs
  in the subject.
- Never push, tag, amend, force, rebase, reset, stash, checkout, commit empty or use `--no-verify`. Report a
  failing hook and stop; never rewrite the message to get past a guard.
- One commit per request. The request authorizes it: do not ask about language, scope, splitting or
  confirmation — decide from the repository. Skip the commit only when the user explicitly asks to show the
  message without committing.
- If the user names paths, run `git add -A -- <paths>` first; otherwise `commit.sh` stages everything only
  when nothing is staged, honoring an existing partial index.
- Ask nothing and add no checklist. Report the outcome, including failures, as it happened.

## Collect

Run `bash .ai/skills/git-commit-message/scripts/collect.sh`. One read-only call returns root, branch,
in-progress operations, status, staged/unstaged stats, recent subjects and full messages, capped diffs and
untracked files.

- `NOT_A_GIT_REPO` → say it is not a Git repository and stop. Empty `STATUS` → say the tree is clean.
  Non-empty `IN PROGRESS` → report the operation and stop.
- `STAGED: yes` → compose from the staged diff; `STAGED: none` → compose from the complete change set and
  `commit.sh` will stage it. Untracked-only trees still get a message.

## Compose

Infer style from history:

1. English only, even when history is Chinese.
2. Follow the prevailing format; Tide uses Conventional Commits, but copy a bare style or ticket prefix when
   history does.
3. Subject ≤72 characters, imperative present tense, no trailing period. `type` is one of
   `feat|fix|refactor|perf|test|docs|chore|build|ci|style|revert`; `scope` is the most-affected directory or
   package and is omitted when unclear.
4. Blank line, then English `- ` bullets explaining what changed and why — no file listing or diff recap.
   Add `Refs:` or `BREAKING CHANGE:` only when needed.
5. Do not invent motivation; describe intent factually. For many unrelated modules, write one summary and
   note that splitting would be cleaner; do not split the commit.

## Commit and reply

Quote the subject. The script refuses in-progress operations and empty commits, stages all changes with
`git add -A` only when the index is empty, commits with a single `-m`, then prints `== COMMITTED ==` with the
hash, subject and remaining status. On `NOTHING_TO_COMMIT` say so; on `COMMIT_FAILED` show the hook/Git output,
keep the index staged and stop.

Put the full draft in one `text` code block, then one short line naming the hash and subject:
`Committed <hash>: <subject> (subject only; body shown above)`. On failure, replace that line with the
failing output and current staged state. Never say "copy this" or "should I commit" — the commit already
happened.
