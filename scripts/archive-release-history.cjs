const fs = require('node:fs')
const path = require('node:path')

/** Archive only the published notes, using a non-forced branch update and a fresh parent on contention. */
module.exports = async function archive({ github, context, core, version, directory = 'dist' }) {
  const { compareVersions } = await import('./release-history.mjs')
  const { owner, repo } = context.repo
  const { data: repository } = await github.rest.repos.get({ owner, repo })
  const branch = repository.default_branch
  const incoming = JSON.parse(
    fs.readFileSync(path.join(directory, 'changes/releases.json'), 'utf8'),
  )
  const consumed = fs.readFileSync(path.join(directory, 'release-fragment.md'), 'utf8')
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: head } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
    const parent = head.object.sha
    const { data: commit } = await github.rest.git.getCommit({ owner, repo, commit_sha: parent })
    const read = async (path) => {
      try {
        const { data } = await github.rest.repos.getContent({ owner, repo, path, ref: parent })
        if (Array.isArray(data) || data.type !== 'file')
          throw new Error(`Expected a file at ${path}`)
        return Buffer.from(data.content, 'base64').toString('utf8')
      } catch (error) {
        if (error.status === 404) return ''
        throw error
      }
    }
    const previousText = await read('changes/releases.json')
    const previous = previousText ? JSON.parse(previousText).releases : []
    const byVersion = new Map(previous.map((release) => [release.version, release]))
    for (const release of incoming.releases) {
      if (release.version === version || !byVersion.has(release.version))
        byVersion.set(release.version, release)
    }
    const releases = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version))
    const nextText = `${JSON.stringify({ schemaVersion: 1, releases }, null, 2)}\n`
    const markdown = `# Changelog\n\nGenerated from release tags and commit ranges. Missing version tags are not invented.\n\n${releases.map((release) => `## v${release.version} — ${release.date.slice(0, 10)}\n\n${release.notes}${release.publishedNotes ? `\n\n### Published release notes\n\n${release.publishedNotes}` : ''}`).join('\n\n')}\n`
    const tree = []
    if (nextText !== previousText)
      tree.push({
        path: 'changes/releases.json',
        mode: '100644',
        type: 'blob',
        content: nextText,
      })
    if (markdown !== (await read('CHANGELOG.md')))
      tree.push({ path: 'CHANGELOG.md', mode: '100644', type: 'blob', content: markdown })
    // Never consume a new summary added to main while installers were building.
    if (consumed.trim() !== '# Unreleased' && (await read('changes/unreleased.md')) === consumed) {
      tree.push({
        path: 'changes/unreleased.md',
        mode: '100644',
        type: 'blob',
        content: '# Unreleased\n',
      })
    }
    if (!tree.length) {
      core.info('Release history already archived')
      return
    }
    const { data: createdTree } = await github.rest.git.createTree({
      owner,
      repo,
      base_tree: commit.tree.sha,
      tree,
    })
    const { data: created } = await github.rest.git.createCommit({
      owner,
      repo,
      message: `docs(release): archive v${version}`,
      tree: createdTree.sha,
      parents: [parent],
    })
    try {
      await github.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: created.sha,
        force: false,
      })
      core.info('Archived release history and consumed the published change summary')
      return
    } catch (error) {
      if (error.status !== 422 || attempt === 2) throw error
    }
  }
}
