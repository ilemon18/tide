---
summary: Configuration transfer and scheduled backups
scope:
  - .ai/configuration.md
  - src/components/ConfigSettings*.tsx
  - src/lib/configBackup*.ts
  - src-tauri/src/commands/config.rs
keywords:
  - configuration
  - backup
  - export
  - import
  - 配置
  - 备份
  - 导出
  - 导入
---
# Configuration transfer and backups

`configBackup.ts` owns document envelopes and scheduling; `commands/config.rs` owns dialogs, bounded
reads and atomic export/recovery writes. Settings defaults, migration and cross-window keys:
[runtime.md](./runtime.md). `ConfigSettings` reuses `SettingsControls` cards, rows and toggles.

## Compatibility and writes

- Export all persisted preferences/shortcuts/shell choices via `exportSettings`, never spread the store's
  runtime methods or palette. Sessions, chat history and provider records keep separate storage.
- Accept plain settings and versioned `tide-config` JSON objects. Preserve future fields, schema and envelope
  metadata; known missing/invalid fields use defaults. Migration only appends. New preferences must update
  TypeScript/Rust defaults and `SHARED_KEYS` together; backup sync and automatic save default off.
- Import writes `settings.before-import.json` before changing settings, then applies and awaits the save
  chain. A failed recovery write leaves settings untouched. Unknown imported methods never hydrate into stores.
- Native local/HTTP(S) reads and exports are bounded by `MAX_CONFIG_BYTES` in `commands/config.rs`; URLs reject
  embedded credentials and reads reject HTML/arrays. Export names are contained single components. Automatic
  writes use the persisted chosen folder; `paths::write_atomic` owns replacement.

## Scheduling

- Only `IS_PRIMARY_WINDOW` starts the scheduler. Recheck loaded/enabled/folder settings before writes,
  serialize backups and catch missed intervals on launch; unsubscribe and clear timers on teardown.
- Daily/three-day/weekly intervals use calendar days; monthly clamps to month-end. Dated names use UTC
  timestamps; overwrite uses one stable name. Advance the timestamp only after a successful write, and
  ignore completion after destination/switch changes. Failures retry with bounded delay.
- `migrateSettings` rejects backup timestamps outside JavaScript Date's range; keep this guard when adding
  sync sources. Format version, application version and settings schema are independent values.
- Future synchronization must retain these compatibility, ownership and recovery contracts; adding a URL
  source does not authorize background network sync.

Tests: `configBackup.test.ts` covers envelopes/calendar/retries; `settings.test.ts` covers recovery,
unknown-field retention and numeric fallback. Gate: [checks.md](./checks.md).
