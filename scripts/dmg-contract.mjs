// Shared by the release preflight, background generator and packaging regression tests.
// tauri.conf.json owns the window dimensions and native icon positions.
export function dmgLayoutIssues(dmg) {
  if (!dmg || typeof dmg !== 'object') return ['bundle.macOS.dmg is missing']
  const issues = []
  if (typeof dmg.background !== 'string' || !dmg.background.endsWith('.png')) {
    issues.push('DMG background must reference the generated PNG')
  }
  const { width, height } = dmg.windowSize ?? {}
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    issues.push('DMG windowSize must contain positive integer dimensions')
    return issues
  }
  for (const name of ['appPosition', 'applicationFolderPosition']) {
    const { x, y } = dmg[name] ?? {}
    if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || x >= width || y <= 0 || y >= height) {
      issues.push('DMG ' + name + ' must be inside windowSize')
    }
  }
  if (issues.length === 0 && (
    dmg.appPosition.x >= dmg.applicationFolderPosition.x ||
    dmg.appPosition.y !== dmg.applicationFolderPosition.y
  )) {
    issues.push('DMG must place Tide to the left of Applications on the same row')
  }
  return issues
}

export function dmgConfigIssues(dmg, readBackground) {
  const issues = dmgLayoutIssues(dmg)
  if (issues.length) return issues
  let png
  try {
    png = readBackground(dmg.background)
  } catch (err) {
    return ['cannot read DMG background: ' + err.message]
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    png.length < 45 || !png.subarray(0, 8).equals(signature) ||
    png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND'
  ) {
    return ['DMG background is not a complete PNG']
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== dmg.windowSize.width || height !== dmg.windowSize.height) {
    issues.push('DMG background dimensions ' + width + 'x' + height + ' do not match windowSize')
  }
  return issues
}

export function dmgWorkflowIssues(workflow) {
  // Keep the opt-in in the actual build step; a matching comment or another step is insufficient.
  const lines = workflow.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'))
  const start = lines.findIndex((line) => /^      - name: Build release installers\s*$/.test(line))
  if (start < 0) return ['release workflow is missing the installer build step']
  const next = lines.findIndex((line, index) => index > start && /^      - /.test(line))
  const step = lines.slice(start, next < 0 ? undefined : next).join('\n')
  const optIn = /if \[ "\$\{RUNNER_OS\}" = "macOS" \]; then\s+export TAURI_BUNDLER_DMG_IGNORE_CI=true\s+fi/.exec(step)
  if (!optIn || !/pnpm tauri build\b/.test(step.slice(optIn.index + optIn[0].length))) {
    return ['macOS installer build must export TAURI_BUNDLER_DMG_IGNORE_CI=true before tauri build']
  }
  if (!/set -euo pipefail\b/.test(step)) {
    return ['installer build must stop when DMG layout creation fails']
  }
  return []
}
