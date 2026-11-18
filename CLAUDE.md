# Claude Code — Tide

Mandatory: follow [AGENTS.md](./AGENTS.md) for the whole session. It is the single source of truth.

- Default mode is code only: do not run i18n, workflow, typecheck, Rust, doc or test checks while coding.
- Write tests if needed; execution belongs to the final verification skill.
- Run [`.ai/skills/verify/SKILL.md`](./.ai/skills/verify/SKILL.md) only when the user asks to verify,
  check or 收尾.
- Run [.ai/skills/release-check/SKILL.md](./.ai/skills/release-check/SKILL.md) only when the user asks
  for a release check / 发布前检查 / 打包前检查.
- Never build, package or launch the GUI unless explicitly asked.

@AGENTS.md
