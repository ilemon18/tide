---
summary: Changelog, versioning and publication
scope:
  - .ai/release.md
  - CHANGELOG.md
  - changes/**
  - .github/workflows/release.yml
  - scripts/release-*.mjs
  - scripts/archive-release-history.cjs
  - scripts/make-latest-json.mjs
keywords:
  - release
  - changelog
  - version
  - publish
  - 发布
  - 版本
  - 变更
---
# Release history and delivery

## Release history

`changes/unreleased.md` owns the current human-written change summary; update it with feature/fix work.
`scripts/release-history.mjs` backfills from v0.0.10 using actual tag ranges and commit SHAs, retains curated notes,
fetches published descriptions with the workflow token, preserves records if tags disappear, and assigns
the summary to the requested version.
`changes/releases.json` and `CHANGELOG.md` are generated project records; no missing tags are invented.
The version job generates one artifact for both builds and publication. `make-latest-json` carries its notes
to existing apps; the complete history remains an archive asset. Publication attaches the history and changelog; `scripts/archive-release-history.cjs`
archives only these records to the default branch via a non-forced Git update, retrying contention. It consumes
only the exact published summary, preserving concurrent new entries. Installers/version stamps are separate.

## Change map

Keep release generation, archival and publication contracts aligned with the tag-driven workflow.
Guard commands: [checks.md](./checks.md).
