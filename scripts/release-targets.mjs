/**
 * Release naming and build targets shared by the manifest generator and the release preflight.
 *
 * The workflow matrix cannot import this file, so `scripts/release-check.mjs` cross-checks the
 * matrix against these values. Change both together when a platform moves.
 */
export const RELEASE_TARGETS = {
  macos: {
    runner: 'macos-15-intel',
    target: 'universal-apple-darwin',
    rustTargets: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
    bundles: 'dmg',
    bundleDir: 'dmg',
    assetPrefix: 'tide-macos',
    extension: 'dmg',
  },
  windows: {
    runner: 'windows-latest',
    target: 'x86_64-pc-windows-msvc',
    rustTargets: ['x86_64-pc-windows-msvc'],
    bundles: 'nsis',
    bundleDir: 'nsis',
    assetPrefix: 'tide-win',
    extension: 'exe',
  },
}
