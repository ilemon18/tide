---
summary: Settings page structure and persistence
scope:
  - .ai/settings.md
  - src/components/SettingsView.tsx
  - src/components/SettingsView.test.tsx
  - src/components/SettingsView.format.test.tsx
  - src/components/SettingsControls.tsx
  - src/lib/settingsSections.ts
  - src/store/settings.ts
  - src/store/settings.test.ts
  - src-tauri/src/commands/theme.rs
keywords:
  - settings
  - preferences
  - persistence
  - migration
  - defaults
  - 设置
  - 偏好
  - 持久化
  - 迁移
---
# Settings page and persistence

## Ownership

`SettingsView` owns section layout and controls; `settingsSections` owns navigation metadata; `store/settings.ts`
and Rust `commands/theme.rs` own defaults, migration and writes. Configuration transfer stays in
[configuration.md](./configuration.md); themes and fonts: [themes.md](./themes.md); window shell and memory:
[runtime.md](./runtime.md).

## Page structure

- `SettingsView` renders cards, rows and steppers from `SettingsControls`. Formatting sections act on editor
  formatters, but formatting behavior is owned by [editor.md](./editor.md).
- Appearance controls consume `THEME_GROUPS`/`palettes` and `MONO_FONT_OPTIONS`; the palette and font contracts
  live in [themes.md](./themes.md). Configuration transfer has separate cards in
  [configuration.md](./configuration.md).

## Defaults, migration and writes

- `DEFAULT_SETTINGS` (`store/settings.ts`) and `Settings::default` (`commands/theme.rs`) stay identical.
  Fresh installs migrate/write back Rust schema-0 defaults; then `settings.json` wins. Migrations append and
  preserve unknown fields.
- Add settings in types/defaults, migration, UI and `SHARED_KEYS`; retirement removes both defaults and adds
  `RETIRED_KEYS`. Runtime choices write immediately and sync across windows; Go Live too.
- `settings.json`/`session.json` use `app_config_dir` and the Rust theme lock. Sidebar/drawer widths stay
  window-local; chat storage follows [agent-storage.md](./agent-storage.md).
- Schema 20 includes terminal styling and bounded global commit templates; missing fields use defaults.
  Code/UI/terminal weights are independent (100–900 by 100, default 400), italic defaults off and rainbow
  brackets on. `commitMessageLimits.json` owns template/history limits; `SHARED_KEYS` includes templates.
- Tests: `settings.test.ts` covers recovery and unknown-field retention; `SettingsView.test.tsx` covers the page.

## Change map

Synchronize setting types/defaults, migrations, shared keys and UI. Gate: [checks.md](./checks.md).
