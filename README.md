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

## Install

```sh
curl -fsSL https://github.com/ilemon18/tide/releases/latest/download/install.sh | sh
```

Windows users: download the `.exe` from [GitHub Releases](https://github.com/ilemon18/tide/releases/latest).

## Why Tide?

Tide is a focused, AI-native editor for people who want a fast, lightweight workspace without giving up familiar editing conventions. It is designed as a lighter alternative for everyday coding, not as a complete replacement for the full VS Code ecosystem.

| | Tide | VS Code |
| --- | --- | --- |
| **Startup approach** | Starts from a focused core and loads project resources on demand, with an optional lightweight mode for constrained environments. | Starts a broad editor platform; actual startup time depends on installed extensions, workspace size, and enabled services. |
| **Memory and background work** | Uses bounded caches for editor state, file trees, search, terminals, and agent chats, and can release inactive resources after focus loss or when the window is hidden. | Extension hosts, language servers, debuggers, and other services can add long-lived processes; actual memory use varies by setup. |
| **Runtime architecture** | Tauri 2 + Rust with the operating system WebView, so Chromium is not bundled. | Electron with a bundled Chromium runtime. |
| **Built-in AI** | Local AI coding agents run in dedicated chat tabs, with file and folder references, model and reasoning controls, and resumable conversations. | AI capabilities come through extensions or connected services, with behavior and availability determined by the chosen tools. |
| **Out-of-the-box workflow** | Includes Git, a native terminal, global search, structure outline, quick open, find and replace, and optional formatting in a focused editor. | Provides broad editing and source-control foundations, with much of its specialized workflow supplied by extensions. |
| **Ecosystem and advanced tooling** | Prioritizes a cohesive built-in workflow rather than VS Code extension compatibility. | Offers a large extension marketplace plus mature debugging, remote development, and language-specific tooling. |
| **Best fit** | Fast, lightweight, AI-native editing for focused everyday projects. | Projects that depend on extension breadth, integrated debugging, remote development, or specialized language tools. |

The lightweight approach is part of the architecture, not just a shorter feature list: quick-open indexing is built on demand, caches and resident document state are bounded, inactive resources can be released when focus is lost or the window is hidden, lightweight mode is available, and the app relies on the system WebView instead of packaging Chromium.

**Choose Tide** when a fast, lightweight, AI-native workspace matters more than a large extension catalog. **Choose VS Code** when your workflow depends on marketplace extensions, integrated debugging, remote development, or deeply specialized language tooling.

Performance and resource use vary with the project, settings, installed tools, and running services. This comparison describes product focus rather than benchmark results.

## Features

- **AI pair programming**: Local AI coding agents in dedicated tabs.
- **Fast by design**: On-demand indexing and bounded caches.
- **Familiar editing**: VS Code shortcuts, command palette, split view, and find & replace.
- **Integrated workflow**: Git, global search, outline, and a multi-tab terminal.
- **Personalized workspace**: Session restore, 21 themes, and six languages.
