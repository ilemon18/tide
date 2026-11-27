---
summary: Theme palettes, fonts and first paint
scope:
  - .ai/themes.md
  - src/components/ThemeMenu.tsx
  - src/theme/**
  - src/lib/fonts.ts
  - src/lib/fonts.test.ts
  - src/assets/fonts/**
  - public/licenses/**
  - scripts/fonts.test.mjs
  - scripts/generate-terminal-oblique.py
  - src/lib/iconTheme.ts
  - public/theme-boot.js
  - src/styles/index.css
keywords:
  - theme
  - palette
  - color
  - font
  - icon
  - 主题
  - 调色板
  - 字体
  - 颜色
---
# Themes, palettes and fonts

## Ownership

`src/theme` owns token generation and application; `ThemeMenu` selects themes; `fonts.ts` owns mono stacks;
`iconTheme.ts` maps file icons. Settings persistence: [settings.md](./settings.md).

## Tokens and themes

- `apply.ts` writes CSS variables consumed by `index.css`; `cmTheme.ts`, `xtermTheme.ts` and `syntax.ts`
  project the same palette into CodeMirror, the terminal and syntax highlighting.
- Built-ins follow VS Code's bundled theme JSON, third-party themes their official VS Code extension, and
  `tide`/`eyecare` remain custom. Keep activity/title/tab/status surface tokens explicit;
  `src/theme/palettes.test.ts` pins upstream projections.
- `public/theme-boot.js` reads the last appearance from localStorage and paints before React to avoid a
  first-frame flash; `data-theme` and the CSS variables are the shared contract.

## Fonts and icons

- `fonts.ts` is the mono-font registry shared by editor, terminal and UI. Adding a font touches this file and
  the SettingsView list, and every stack keeps CJK/system fallbacks. `index.css` declares the bundled
  `@font-face` families.
- Preserve font ids: Consolas is local with fallback; Fira Code and Smiley Sans are bundled with licenses.
  Font assets retain source/checksum records. Terminal oblique generation and xterm face rules:
  [terminal.md](./terminal.md). Styling changes never recreate PTYs or editor states.
- `iconTheme.ts` maps file types to bundled icons; generated assets keep their generators.

## Change map

Theme changes coordinate UI/CodeMirror/xterm tokens and fonts; keep palette projections pinned.
Gate: [checks.md](./checks.md).
