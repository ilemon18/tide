---
summary: Markdown editing, preview and image containment
scope:
  - .ai/markdown.md
  - src/components/MarkdownPreview.tsx
  - src/components/MarkdownRenderer.tsx
  - src/lib/markdown.ts
  - src/editor/markdownDocs.ts
keywords:
  - markdown
  - preview
  - image
  - link
  - 预览
  - 图片
  - 链接
---
# Markdown editing and preview

## Ownership

`MarkdownPreview` owns the split preview pane, `MarkdownRenderer` renders GFM, `lib/markdown.ts` resolves
paths and `editor/markdownDocs.ts` multiplexes document updates. Tabs and CodeMirror:
[editor.md](./editor.md).

## Preview lifecycle

- Per-pane/tab `markdownPreview` keeps source ratios on moves; close, rename away, replacement and merge
  clear it. Dirty text keeps the source editor mounted beside the preview.
- `markdownDocs` publishes CodeMirror `Text` to preview subscribers independently of split-pane mirroring.
  Updates coalesce to one render per 100ms with a guaranteed trailing render; preview scrolling stays
  independent.
- Parsing is lazy-loaded, so opening a preview does not pull Markdown parsing into the startup bundle.

## Safety

- Reject HTML and navigation; links never replace the editor WebView. Images resolve only to relative
  workspace raster paths; remote, absolute, escaping, data/file and SVG sources fall back to alt text.
- `resolveMarkdownImage` is the lexical first pass; Rust containment remains authoritative. Failed image reads
  render the fallback label, and object URLs are revoked when the pane disposes.

## Change map

Keep preview throttling, image containment and link blocking aligned. Gate: [checks.md](./checks.md).
