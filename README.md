<p align="center">
  <img src="assets/icon.png" width="110" alt="Tide" />
</p>

<h1 align="center">Tide</h1>

<p align="center">
  A lightweight code editor built with Rust and inspired by VS Code — a lighter VS Code alternative.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | English
</p>

<p align="center">
  <a href="https://github.com/ilemon18/tide/releases">Download</a>
</p>

<p align="center">
  <img src="docs/screenshots/00.png" alt="Tide screenshot" />
</p>

## Why Tide?

Tide is a focused, AI-native editor for people who want a fast, lightweight workspace without giving up familiar editing conventions. It is designed as a lighter alternative for everyday coding, not as a complete replacement for the full VS Code ecosystem.

| | Tide | VS Code |
| --- | --- | --- |
| **Startup approach** | Starts from a focused core and loads project resources on demand, with an optional lightweight mode for constrained environments. | Starts a broad editor platform; actual startup time depends on installed extensions, workspace size, and enabled services. |
| **Memory and background work** | Uses bounded caches for editor state, file trees, search, terminals, and agent chats, and can release inactive resources after focus loss or when the window is hidden. | Extension hosts, language servers, debuggers, and other services can add long-lived processes; actual memory use varies by setup. |
| **Runtime architecture** | Tauri 2 + Rust with the operating system WebView, so Chromium is not bundled. | Electron with a bundled Chromium runtime. |
| **Built-in AI** | Claude Code and Codex run in dedicated chat tabs from locally installed CLIs, with file and folder references, model and reasoning controls, and resumable conversations. | AI capabilities come through extensions or connected services, with behavior and availability determined by the chosen tools. |
| **Out-of-the-box workflow** | Includes Git, a native terminal, global search, structure outline, quick open, find and replace, and optional formatting in a focused editor. | Provides broad editing and source-control foundations, with much of its specialized workflow supplied by extensions. |
| **Ecosystem and advanced tooling** | Prioritizes a cohesive built-in workflow rather than VS Code extension compatibility. | Offers a large extension marketplace plus mature debugging, remote development, and language-specific tooling. |
| **Best fit** | Fast, lightweight, AI-native editing for focused everyday projects. | Projects that depend on extension breadth, integrated debugging, remote development, or specialized language tools. |

The lightweight approach is part of the architecture, not just a shorter feature list: quick-open indexing is built on demand, caches and resident document state are bounded, inactive resources can be released when focus is lost or the window is hidden, lightweight mode is available, and the app relies on the system WebView instead of packaging Chromium.

**Choose Tide** when a fast, lightweight, AI-native workspace matters more than a large extension catalog. **Choose VS Code** when your workflow depends on marketplace extensions, integrated debugging, remote development, or deeply specialized language tooling.

Performance and resource use vary with the project, settings, installed tools, and running services. This comparison describes product focus rather than benchmark results.

## Features

- **Built-in AI agent**:  
  Chat with locally installed Claude Code or Codex in dedicated tabs, stream reasoning and tool activity, reference files or folders with `@`, choose the model and reasoning effort, and resume conversations across sessions.
- **Light on memory**:  
  On-demand indexing and bounded caches keep Tide focused on the active project.
- **Familiar editing**:  
  VS Code shortcuts, command palette, tabs, split view, and find & replace.
- **Structure outline**:  
  A per-file symbol tree in the sidebar, plus `@` symbol jump in quick open.
- **Built-in Git**:  
  Stage, commit, push/pull, diffs, inline blame, and conflict resolution.
- **Native terminal**:  
  Multi-tab PTY starting in the current file's directory.
- **Global search**:  
  Respects .gitignore, with regex, path filters, and batch replace.
- **Optional formatting**:  
  Off by default; matches formatters to file types when enabled.
- **Session restore**:  
  Restores projects, files, and cursor positions, with multi-window support.
- **Editor customization**:  
  Choose editor fonts and sizes, with optional programming ligatures.
- **21 themes**:  
  Popular color schemes with system-theme support.
- **Six languages**:  
  Simplified/Traditional Chinese, English, Japanese, Korean, and Spanish; switch instantly.
