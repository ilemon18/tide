---
name: polish-ui-copy
description: Tighten UI copy introduced by a feature by removing redundant labels, helper text and decoration while preserving actions, consequences, errors and accessibility. Use only when the user explicitly asks to polish copy, reduce UI text, simplify hints, 精简文案, 优化文案 or 去掉多余提示.
---

# Polish UI copy

Use only when explicitly invoked. Edit the smallest UI scope and its locale catalogs directly; this is not a
verification gate. Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## Scope

- Start with the paths, screen or feature the user names. Otherwise inspect `git diff --name-only` and
  `git diff` for the current feature, including staged and untracked files. If no scope exists, review the
  smallest area that can contain the requested feature.
- Review visible UI text: headings, labels, buttons, subtitles, hints, placeholders, empty states, toasts,
  dialogs, warnings, tooltips and accessibility labels.
- Exclude README, CHANGELOG, other docs, comments, logs, test names and backend-only messages unless the text
  appears in the UI.
- Read [`.ai/i18n.md`](../../i18n.md) and the affected components before editing. Do not rewrite unrelated
  copy found along the way; report it as follow-up.

## Triage every string

For each string, identify what the user must understand, decide, do or recover from at that moment.

- **Keep** action names, invisible state, risk and consequences, error causes, recovery steps, permission or
  destructive-action warnings, accessibility labels and necessary shortcut help.
- **Remove** subtitles that repeat the heading, explanations of obvious controls, a second description of the
  same action, decorative or promotional text, and labels already expressed by layout or control state.
- **Merge** label/description pairs, tooltip/hint pairs and multiple hints for one state into one useful
  message.
- **Rewrite** as verb + object, front-load the action or outcome, and drop filler such as “You can…”,
  “This allows you to…” and “Please note…”. Keep one idea per string.
- **Layout first** when deletion makes a control ambiguous: improve grouping, hierarchy, iconography or label
  placement instead of adding another sentence. Do not move every removed description into a tooltip; optional
  help is not a graveyard for deleted copy.

Warnings, errors, destructive consequences and accessibility are not simplification targets. Keep their
meaning and recovery path; remove only duplicated framing. Fewer strings is not success if the user can no
longer make the same decision safely.

## Edit Tide copy

- `src/i18n/messages/en.ts` defines the keys; update all six locale catalogs together and preserve
  `{placeholder}` names and plural form counts.
- Remove references and now-unused keys only after the last usage is gone. Keep `t()` at the UI boundary,
  including placeholders and accessibility labels; never add hardcoded UI copy.
- Update tests that assert changed copy with the implementation. Never weaken or delete a test just to accept
  missing guidance.
- Do not run project gates, build the app or perform GUI checks from this skill. When the user separately asks
  for verification, follow the project verification gate.

## Report

Make the edits, then show a compact mapping of location, before, after and reason: removed repeated subtitle,
merged hint, shortened action label or kept destructive consequence. Call out warnings, errors and
accessibility copy that were deliberately preserved. Mention any out-of-scope copy as follow-up rather than
changing it.

## Examples

- `Export configuration` plus `Download your settings as a JSON file` → keep the action when its context
  already explains the result.
- `Delete project?` plus `This action cannot be undone.` → keep the consequence; it changes the decision.
- `Agent history` plus `View your previous chats` → remove the subtitle; the heading already explains it.
- `Cannot save: disk is full. Free space and retry.` → keep the compact cause and recovery, not a second
  warning paragraph.
