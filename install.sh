#!/bin/sh
# Install the latest stable Tide release on macOS without sudo.
set -eu
umask 077

REPO="ilemon18/tide"
MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/latest.json"
APP_NAME="Tide.app"
INSTALL_DIR="${HOME:-}/Applications"
DEST="${INSTALL_DIR}/${APP_NAME}"

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  die "Tide's shell installer supports macOS only. Windows: download the .exe from https://github.com/${REPO}/releases/latest."
fi

if [ -z "${HOME:-}" ]; then
  die "HOME is not set."
fi

for tool in awk curl ditto find grep hdiutil mktemp open plutil shasum tr wc; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done

tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/tide-install.XXXXXX") || die "could not create a temporary directory."
mount_dir="${tmp_root}/mount"
manifest_json="${tmp_root}/latest.json"
manifest_plist="${tmp_root}/latest.plist"
dmg_file="${tmp_root}/tide.dmg"
apps_tmp=""
backup_app=""
had_existing=0
mounted=0
keep_apps_tmp=0

cleanup() {
  exit_code=$?
  trap - 0 HUP INT TERM

  if [ "$mounted" -eq 1 ]; then
    if ! hdiutil detach "$mount_dir" >/dev/null 2>&1; then
      hdiutil detach "$mount_dir" -force >/dev/null 2>&1 ||
        warn "could not unmount DMG at ${mount_dir}."
    fi
  fi

  if [ "$had_existing" -eq 1 ] && [ ! -e "$DEST" ] && [ -n "$backup_app" ] && [ -e "$backup_app" ]; then
    if ! mv "$backup_app" "$DEST"; then
      keep_apps_tmp=1
      warn "could not restore ${DEST}; previous app: ${backup_app}."
    fi
  fi

  if [ "$keep_apps_tmp" -eq 0 ] && [ -n "$apps_tmp" ]; then
    rm -rf "$apps_tmp"
  fi
  rm -rf "$tmp_root"
  exit "$exit_code"
}
trap cleanup 0 HUP INT TERM

mkdir "$mount_dir"

say "Downloading manifest..."
if ! curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --retry-delay 1 \
  --output "$manifest_json" "$MANIFEST_URL"; then
  die "could not download ${MANIFEST_URL}."
fi

if ! plutil -convert xml1 -o "$manifest_plist" "$manifest_json" >/dev/null 2>&1; then
  die "latest.json is not valid JSON."
fi
if ! plutil -lint "$manifest_plist" >/dev/null 2>&1; then
  die "latest.json is not a valid release manifest."
fi

plist_value() {
  plutil -extract "$1" raw -o - "$manifest_plist" 2>/dev/null
}

if ! version=$(plist_value version); then
  die "latest.json is missing version."
fi
if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'; then
  die "invalid version in latest.json: ${version}"
fi

if ! asset_name=$(plist_value assets.macos.name); then
  die "latest.json is missing assets.macos.name."
fi
expected_name="tide-macos-${version}.dmg"
if [ "$asset_name" != "$expected_name" ]; then
  die "unexpected macOS asset name: ${asset_name}; expected ${expected_name}."
fi

if ! asset_url=$(plist_value assets.macos.url); then
  die "latest.json is missing assets.macos.url."
fi
expected_url="https://github.com/${REPO}/releases/download/v${version}/${asset_name}"
if [ "$asset_url" != "$expected_url" ]; then
  die "unexpected macOS URL: ${asset_url}"
fi

if ! asset_size=$(plist_value assets.macos.size); then
  die "latest.json is missing assets.macos.size."
fi
case "$asset_size" in
  ''|*[!0-9]*) die "invalid macOS size in latest.json: ${asset_size}" ;;
esac
if [ "$asset_size" -le 0 ] 2>/dev/null; then
  die "invalid macOS size in latest.json: ${asset_size}"
fi

if ! asset_sha256=$(plist_value assets.macos.sha256); then
  die "latest.json is missing assets.macos.sha256."
fi
case "$asset_sha256" in
  ''|*[!0-9a-f]*) die "invalid macOS SHA-256 in latest.json: ${asset_sha256}" ;;
esac
if [ "${#asset_sha256}" -ne 64 ]; then
  die "invalid macOS SHA-256 in latest.json: ${asset_sha256}"
fi

say "Downloading Tide ${version}..."
if ! curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --retry-delay 1 \
  --output "$dmg_file" "$asset_url"; then
  die "could not download ${asset_url}."
fi

actual_size=$(wc -c < "$dmg_file" | tr -d '[:space:]')
if [ "$actual_size" -ne "$asset_size" ]; then
  die "downloaded DMG size is ${actual_size} bytes; latest.json says ${asset_size}."
fi

actual_sha256=$(shasum -a 256 "$dmg_file" | awk '{print $1}')
if [ "$actual_sha256" != "$asset_sha256" ]; then
  die "downloaded DMG SHA-256 does not match latest.json."
fi

say "Mounting DMG..."
if ! hdiutil attach -nobrowse -readonly -mountpoint "$mount_dir" "$dmg_file" >/dev/null; then
  die "could not mount DMG."
fi
mounted=1

app_list="${tmp_root}/apps.txt"
find "$mount_dir" -type d -name "$APP_NAME" -print > "$app_list"
app_count=$(wc -l < "$app_list" | tr -d '[:space:]')
if [ "$app_count" -ne 1 ]; then
  die "the DMG must contain exactly one ${APP_NAME}; found ${app_count}."
fi
IFS= read -r source_app < "$app_list" || die "could not read the mounted app path."

if ! bundle_version=$(plutil -extract CFBundleShortVersionString raw -o - "$source_app/Contents/Info.plist" 2>/dev/null); then
  die "the mounted app has no CFBundleShortVersionString."
fi
if [ "$bundle_version" != "$version" ]; then
  die "the mounted app version is ${bundle_version}; latest.json says ${version}."
fi

mkdir -p "$INSTALL_DIR" || die "could not create ${INSTALL_DIR}."
apps_tmp=$(mktemp -d "${INSTALL_DIR}/.tide-install.XXXXXX") || die "could not create staging directory in ${INSTALL_DIR}."
staged_app="${apps_tmp}/${APP_NAME}"
backup_app="${apps_tmp}/${APP_NAME}.previous"

say "Staging app..."
if ! ditto "$source_app" "$staged_app"; then
  die "could not stage ${APP_NAME}."
fi

if ! staged_version=$(plutil -extract CFBundleShortVersionString raw -o - "$staged_app/Contents/Info.plist" 2>/dev/null); then
  die "the staged app has no CFBundleShortVersionString."
fi
if [ "$staged_version" != "$version" ]; then
  die "the staged app version is ${staged_version}; latest.json says ${version}."
fi

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  say "Backing up current app..."
  had_existing=1
  if ! mv "$DEST" "$backup_app"; then
    had_existing=0
    die "could not back up the current installation at ${DEST}."
  fi
fi

if ! mv "$staged_app" "$DEST"; then
  if [ "$had_existing" -eq 1 ]; then
    if mv "$backup_app" "$DEST"; then
      say "Restored previous app."
    else
      preserved_backup="${INSTALL_DIR}/Tide.app.previous.$$"
      if mv "$backup_app" "$preserved_backup"; then
        warn "previous app preserved at ${preserved_backup}."
      else
        keep_apps_tmp=1
        warn "previous app preserved at ${backup_app}; recover it before deleting the staging directory."
      fi
    fi
  fi
  die "could not replace ${DEST}."
fi

if [ "$had_existing" -eq 1 ]; then
  rm -rf "$backup_app" || warn "could not remove previous app at ${backup_app}."
fi

say "Installed Tide ${version} at ${DEST}."
if ! open "$DEST"; then
  warn "Installed, but could not open Tide automatically."
fi
