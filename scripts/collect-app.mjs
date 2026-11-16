// Copy the freshly built debug bundle into ./release so there is only one place for artifacts:
//   macOS   -> release/tide-debug.app
//   Windows -> release/tide-debug-setup.exe
// Names are not hardcoded: on macOS we look for an .app in bundle/macos (the executable name comes
// from the actual contents of Contents/MacOS), on Windows for a *-setup.exe in bundle/nsis.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
mkdirSync(join(root, 'release'), { recursive: true })

/** Delete the old copy before overwriting, so a stale bundle is not opened by mistake (file -> delete file) */
function replace(target, copy) {
  rmSync(target, { recursive: true, force: true })
  copy(target)
}

function collectMac() {
  const bundleDir = join(root, 'src-tauri', 'target', 'debug', 'bundle', 'macos')
  const target = join(root, 'release', 'tide-debug.app')
  const appName = existsSync(bundleDir)
    ? readdirSync(bundleDir).find((name) => name.endsWith('.app'))
    : undefined
  if (!appName) {
    console.error(`build artifact not found: ${bundleDir}/*.app`)
    console.error('Run pnpm app:build first.')
    process.exit(1)
  }

  const source = join(bundleDir, appName)
  const macosDir = join(source, 'Contents', 'MacOS')
  const binary = existsSync(macosDir)
    ? readdirSync(macosDir).find((name) => !name.startsWith('.'))
    : undefined
  if (!binary) {
    console.error(`incomplete build artifact (missing executable): ${macosDir}`)
    process.exit(1)
  }

  replace(target, (dest) => cpSync(source, dest, { recursive: true }))
  const size = (statSync(join(target, 'Contents', 'MacOS', binary)).size / 1024 / 1024).toFixed(1)
  console.log(`copied ${appName} -> release/tide-debug.app (executable ${binary}, ${size} MB)`)
  console.log('open release/tide-debug.app')
}

function collectWindows() {
  const bundleDir = join(root, 'src-tauri', 'target', 'debug', 'bundle', 'nsis')
  const target = join(root, 'release', 'tide-debug-setup.exe')
  const setup = existsSync(bundleDir)
    ? readdirSync(bundleDir).find((name) => name.toLowerCase().endsWith('.exe'))
    : undefined
  if (!setup) {
    console.error(`build artifact not found: ${bundleDir}/*.exe`)
    console.error('Run pnpm app:build:win first.')
    process.exit(1)
  }

  const source = join(bundleDir, setup)
  replace(target, (dest) => cpSync(source, dest))
  const size = (statSync(target).size / 1024 / 1024).toFixed(1)
  console.log(`copied ${setup} -> release/tide-debug-setup.exe (${size} MB)`)
  console.log('Double-click release\\tide-debug-setup.exe to install (per-user install, no admin rights needed)')
}

if (process.platform === 'darwin') collectMac()
else if (process.platform === 'win32') collectWindows()
else {
  console.error('This script supports macOS / Windows only: each platform builds separately, no cross-compiling.')
  process.exit(1)
}
