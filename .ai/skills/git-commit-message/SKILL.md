---
name: git-commit-message
description: Generate an English commit message from uncommitted changes and commit only its subject line, showing the body for reference. Use when the user asks to commit, write a commit message, 提交代码 or 生成提交信息. Never pushes, and stops instead of bypassing hooks, merges or rebases.
---

# Subject-only commit

The user wants a clean English commit message plus a commit whose message is exactly its first line.
The body is a preview: it is shown in the reply and never written to history. This is the only Tide
skill allowed to write Git state, and only through its two scripts.

## Rules

- **Commit the subject only.** Call `.ai/skills/git-commit-message/scripts/commit.sh "<subject>"`; it passes one `-m`, so bullets,
  `Refs:` and `BREAKING CHANGE:` lines stay in the reply and out of the commit. Anything history must
  keep belongs in the subject.
- **Never** push, tag, amend, force, rebase, reset, stash, checkout, commit empty or use `--no-verify`.
  A failing hook is reported and left for the user; never rewrite the message to get past a guard.
- **One commit per request** covering the change set the message describes. The request to commit is
  the authorization, so do not ask whether to commit, nor ask about language, scope, splitting or
  confirmation — decide from the repository. Skip the commit only when the user explicitly says to
  show the message without committing.
- If the user names paths, run `git add -A -- <paths>` first; `commit.sh` then commits that index.
  Otherwise it stages everything only when nothing is staged, so an existing partial index is honored.
- Ask nothing and add no next-step checklist. Report the outcome, including failures, as it happened.

## 1. Collect once

```bash
bash .ai/skills/git-commit-message/scripts/collect.sh
```

One read-only call returns root, branch, in-progress operations, status, staged/unstaged stats,
recent subjects and full messages, both diffs (capped), and untracked files.

- `NOT_A_GIT_REPO` → say the directory is not a Git repository and stop.
- Empty `STATUS` → say the tree is clean; nothing is committed.
- Non-empty `IN PROGRESS` → report the merge/rebase/cherry-pick and stop.
- `STAGED: yes` → compose the message from the staged diff, because that is what gets committed.
  `STAGED: none` → compose it from the complete change set; `commit.sh` will stage all of it.
- Untracked files only → still write the message; they are included by the automatic staging.

## 2. Write the message

Infer the style from the history instead of inventing one:

1. English only, even when the history is Chinese; history informs intent, not language.
2. Follow the prevailing format. Tide uses Conventional Commits (`type(scope): summary`); copy a bare
   style or a ticket prefix such as `[ABC-123]` when that is what history uses.
3. Subject: ≤ 72 characters, imperative present tense (`add`, `fix`, `remove`), no trailing period.
   `type` is one of `feat|fix|refactor|perf|test|docs|chore|build|ci|style|revert`; `scope` is the
   most-affected directory or package and is omitted when unclear.
4. Blank line, then `- ` bullets in English explaining what changed and why — no file-by-file listing
   and no diff recap. Add `Refs: <ticket>` or `BREAKING CHANGE: ...` only when the change needs it.
5. Do not invent business motivation. When intent is unclear, describe the change factually.
6. Many files or several unrelated modules → write one summary message and note that splitting would
   be cleaner; do not split the commit yourself.

## 3. Commit the subject

```bash
bash .ai/skills/git-commit-message/scripts/commit.sh "<subject>"
```

Quote the subject. The script refuses in-progress operations and empty commits, stages all changes
with `git add -A` only when the index is empty, commits with a single `-m`, then prints
`== COMMITTED ==` with `<hash> <subject>` and the remaining status. On `NOTHING_TO_COMMIT` say so;
on `COMMIT_FAILED` show the hook or Git output, keep the index staged and stop.

## 4. Reply

Put the full draft in one `text` code block so the user can read the body that was **not** committed,
then add one short line in the user's language naming the hash and subject, for example:

```text
Committed abc1234: feat(editor): open workspace files as external tabs (subject only; body shown above)
```

On failure, replace that line with the failing output and the current staged state. Never say "copy
this" or "should I commit" — the commit already happened.
