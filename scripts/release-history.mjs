import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gitAt =
  (root) =>
  (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const normalize = (value) => value.replace(/^v/i, '')
export function compareVersions(a, b) {
  const split = (value) => {
    const [core, ...pre] = normalize(value).split('+')[0].split('-')
    return [core, pre.join('-')]
  }
  const [coreA, preA] = split(a),
    [coreB, preB] = split(b)
  const aa = coreA.split('.').map(Number),
    bb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0
  const pa = preA.split('.'),
    pb = preB.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue
    if (pa[i] === undefined) return -1
    if (pb[i] === undefined) return 1
    const numericA = /^\d+$/.test(pa[i]),
      numericB = /^\d+$/.test(pb[i])
    if (numericA && numericB) return Number(pa[i]) - Number(pb[i])
    if (numericA !== numericB) return numericA ? -1 : 1
    return pa[i].localeCompare(pb[i])
  }
  return 0
}

async function publishedReleases(repo, token) {
  if (!token) return []
  const all = []
  for (let page = 1; ; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Tide-release-history' },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok) throw new Error(`Cannot read release history: HTTP ${response.status}`)
    const batch = await response.json()
    all.push(...batch.filter((release) => !release.draft))
    if (batch.length < 100) return all
  }
}

export async function generateHistory({
  root = ROOT,
  version = '',
  ref = 'HEAD',
  repo = 'ilemon18/tide',
  token = '',
  output = ROOT,
  notesFile = '',
} = {}) {
  const git = gitAt(root)
  const historyPath = resolve(root, 'changes/releases.json')
  const previous = existsSync(historyPath)
    ? JSON.parse(readFileSync(historyPath, 'utf8')).releases
    : []
  const published = await publishedReleases(repo, token)
  const releasesByTag = new Map(published.map((release) => [normalize(release.tag_name), release]))
  const tags = git('tag', '--list', 'v*')
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag))
    .sort(compareVersions)
  if (!tags.length)
    throw new Error('Full Git history and tags are required to generate release notes')
  const versions = tags.map((tag) => ({ version: normalize(tag), ref: tag }))
  if (version && !versions.some((entry) => entry.version === normalize(version)))
    versions.push({ version: normalize(version), ref })
  versions.sort((a, b) => compareVersions(a.version, b.version))
  const releases = []
  for (let i = 0; i < versions.length; i++) {
    const entry = versions[i]
    if (compareVersions(entry.version, '0.0.10') < 0) continue
    const range = i > 0 ? `${versions[i - 1].ref}..${entry.ref}` : entry.ref
    const commits = git('log', '--reverse', '--format=%H%x09%s', range)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      })
      .filter((commit) => !commit.subject.startsWith('docs(release): archive '))
    const existing = previous.find((release) => release.version === entry.version)
    const remote = releasesByTag.get(entry.version)
    const notes =
      existing?.notes ||
      commits.map((commit) => `- ${commit.subject} (${commit.sha.slice(0, 7)})`).join('\n')
    releases.push({
      version: entry.version,
      date: remote?.published_at || existing?.date || git('show', '-s', '--format=%cI', entry.ref),
      notes,
      ...(remote?.body || existing?.publishedNotes
        ? { publishedNotes: remote?.body || existing.publishedNotes }
        : {}),
      commits,
    })
  }
  // Retained archives and published release records remain available even if a tag is later removed.
  const recorded = new Set(releases.map(release => release.version))
  for (const release of previous) {
    if (!recorded.has(release.version) && compareVersions(release.version, '0.0.10') >= 0) {
      releases.push(release); recorded.add(release.version)
    }
  }
  for (const release of published) {
    const publishedVersion = normalize(release.tag_name)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(publishedVersion) || recorded.has(publishedVersion) || compareVersions(publishedVersion, '0.0.10') < 0) continue
    releases.push({ version: publishedVersion, date: release.published_at, notes: release.body || '', publishedNotes: release.body || '', commits: [] })
    recorded.add(publishedVersion)
  }
  releases.sort((a, b) => compareVersions(b.version, a.version))
  const target = version ? releases.find((entry) => entry.version === normalize(version)) : null
  const fragment = resolve(root, 'changes/unreleased.md')
  if (target && existsSync(fragment)) {
    const summary = readFileSync(fragment, 'utf8')
      .replace(/^#.*\n/, '')
      .trim()
    if (summary && !target.notes.includes(summary)) target.notes = `${summary}\n\n${target.notes}`
  }
  const document = { schemaVersion: 1, releases }
  mkdirSync(resolve(output, 'changes'), { recursive: true })
  writeFileSync(
    resolve(output, 'changes/releases.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  )
  const unreleased =
    !version && existsSync(fragment)
      ? readFileSync(fragment, 'utf8')
          .replace(/^#.*\n/, '')
          .trim()
      : ''
  const md = `# Changelog\n\nGenerated from release tags and commit ranges. Missing version tags are not invented.\n\n${unreleased ? `## Unreleased\n\n${unreleased}\n\n` : ''}${releases.map((release) => `## v${release.version} — ${release.date.slice(0, 10)}\n\n${release.notes}${release.publishedNotes ? `\n\n### Published release notes\n\n${release.publishedNotes}` : ''}`).join('\n\n')}\n`
  writeFileSync(resolve(output, 'CHANGELOG.md'), md)
  if (notesFile) {
    if (!target) throw new Error(`No release notes for ${version}`)
    mkdirSync(dirname(resolve(notesFile)), { recursive: true })
    writeFileSync(resolve(notesFile), target.notes + '\n')
  }
  return document
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = {
      token: process.env.GITHUB_TOKEN || '',
      repo: process.env.GITHUB_REPOSITORY || 'ilemon18/tide',
    }
  for (let i = 0; i < args.length; i += 2) {
    const key = {
      '--version': 'version',
      '--ref': 'ref',
      '--output': 'output',
      '--notes-file': 'notesFile',
      '--repo': 'repo',
    }[args[i]]
    if (!key || !args[i + 1]) throw new Error(`Unknown or incomplete argument ${args[i]}`)
    options[key] = args[i + 1]
  }
  await generateHistory(options)
}
