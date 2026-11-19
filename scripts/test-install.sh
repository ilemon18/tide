#!/bin/sh
# Exercise install.sh without touching the network, mounted disks or ~/Applications.
set -eu
umask 077

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
INSTALLER="${ROOT}/install.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/tide-install-test.XXXXXX")
stub_dir="${test_root}/bin"
case_dir=""
failures=0

cleanup() {
  exit_code=$?
  trap - 0 HUP INT TERM
  rm -rf "$test_root"
  exit "$exit_code"
}
trap cleanup 0 HUP INT TERM

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS  %s\n' "$1"
}

assert_contains() {
  label=$1
  needle=$2
  haystack=$3
  case "$haystack" in
    *"$needle"*) pass "$label" ;;
    *) fail "$label (missing: $needle)" ;;
  esac
}

assert_absent() {
  label=$1
  path=$2
  if [ -e "$path" ] || [ -L "$path" ]; then
    fail "$label (still exists: $path)"
  else
    pass "$label"
  fi
}

mkdir -p "$stub_dir"

cat > "${stub_dir}/uname" <<'STUB'
#!/bin/sh
printf '%s\n' "${TIDE_TEST_UNAME:-Darwin}"
STUB

cat > "${stub_dir}/curl" <<'STUB'
#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output)
      shift
      out=${1:-}
      ;;
    https://*)
      url=$1
      ;;
  esac
  shift
done
[ -n "$out" ] && [ -n "$url" ] || exit 2
case "$url" in
  */latest.json)
    [ -f "$TIDE_TEST_DIST/latest.json" ] || exit 22
    cp "$TIDE_TEST_DIST/latest.json" "$out"
    ;;
  *.dmg)
    name=${url##*/}
    [ -f "$TIDE_TEST_DIST/$name" ] || exit 22
    cp "$TIDE_TEST_DIST/$name" "$out"
    ;;
  *)
    exit 22
    ;;
esac
STUB

cat > "${stub_dir}/hdiutil" <<'STUB'
#!/bin/sh
action=${1:-}
[ "$#" -gt 0 ] && shift
case "$action" in
  attach)
    mount=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -mountpoint)
          shift
          mount=${1:-}
          ;;
      esac
      shift
    done
    [ -n "$mount" ] || exit 2
    mkdir -p "$mount"
    if [ -d "$TIDE_TEST_APP_SOURCE" ]; then
      cp -R "$TIDE_TEST_APP_SOURCE"/. "$mount"/
    fi
    [ -n "${TIDE_TEST_HDIUTIL_LOG:-}" ] && printf 'attach %s\n' "$mount" >> "$TIDE_TEST_HDIUTIL_LOG"
    ;;
  detach)
    mount=""
    for arg in "$@"; do
      case "$arg" in
        -*) ;;
        *) mount=$arg ;;
      esac
    done
    [ -n "${TIDE_TEST_HDIUTIL_LOG:-}" ] && printf 'detach %s\n' "$mount" >> "$TIDE_TEST_HDIUTIL_LOG"
    ;;
  *)
    exit 2
    ;;
esac
STUB

cat > "${stub_dir}/open" <<'STUB'
#!/bin/sh
[ -n "${TIDE_TEST_OPEN_LOG:-}" ] && printf '%s\n' "$*" >> "$TIDE_TEST_OPEN_LOG"
exit 0
STUB

cat > "${stub_dir}/mv" <<'STUB'
#!/bin/sh
if [ "${TIDE_TEST_FAIL_NEW_MOVE:-0}" = "1" ]; then
  case "${1:-}:${2:-}" in
    */.tide-install.*/Tide.app:"$HOME"/Applications/Tide.app)
      exit 1
      ;;
  esac
fi
exec /bin/mv "$@"
STUB

chmod +x "${stub_dir}/uname" "${stub_dir}/curl" "${stub_dir}/hdiutil" "${stub_dir}/open" "${stub_dir}/mv"

begin_case() {
  case_name=$1
  case_dir="${test_root}/${case_name}"
  mkdir -p "${case_dir}/home" "${case_dir}/tmp" "${case_dir}/dist" "${case_dir}/source"
  HOME="${case_dir}/home"
  TMPDIR="${case_dir}/tmp"
  TIDE_TEST_DIST="${case_dir}/dist"
  TIDE_TEST_APP_SOURCE="${case_dir}/source"
  TIDE_TEST_OPEN_LOG="${case_dir}/open.log"
  TIDE_TEST_HDIUTIL_LOG="${case_dir}/hdiutil.log"
  TIDE_TEST_UNAME=Darwin
  TIDE_TEST_FAIL_NEW_MOVE=0
  export HOME TMPDIR TIDE_TEST_DIST TIDE_TEST_APP_SOURCE TIDE_TEST_OPEN_LOG TIDE_TEST_HDIUTIL_LOG TIDE_TEST_UNAME TIDE_TEST_FAIL_NEW_MOVE
}

make_app() {
  app_path=$1
  app_version=$2
  marker=$3
  mkdir -p "${app_path}/Contents/Resources"
  cat > "${app_path}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${app_version}</string>
</dict>
</plist>
PLIST
  printf '%s\n' "$marker" > "${app_path}/Contents/Resources/marker"
}

make_release() {
  version=$1
  size_override=${2:-}
  sha_override=${3:-}
  url_override=${4:-}
  app_version=${5:-$version}

  dmg_name="tide-macos-${version}.dmg"
  printf 'fake dmg for %s\n' "$version" > "${TIDE_TEST_DIST}/${dmg_name}"
  actual_size=$(wc -c < "${TIDE_TEST_DIST}/${dmg_name}" | tr -d '[:space:]')
  actual_sha=$(shasum -a 256 "${TIDE_TEST_DIST}/${dmg_name}" | awk '{print $1}')
  asset_size=${size_override:-$actual_size}
  asset_sha=${sha_override:-$actual_sha}
  asset_url=${url_override:-https://github.com/ilemon18/tide/releases/download/v${version}/${dmg_name}}

  cat > "${TIDE_TEST_DIST}/latest.json" <<JSON
{
  "version": "${version}",
  "assets": {
    "macos": {
      "name": "${dmg_name}",
      "url": "${asset_url}",
      "size": ${asset_size},
      "sha256": "${asset_sha}"
    }
  }
}
JSON
  make_app "${TIDE_TEST_APP_SOURCE}/Tide.app" "$app_version" "tide-${app_version}"
}

run_installer() {
  PATH="${stub_dir}:/usr/bin:/bin:/usr/sbin:/sbin" sh "$INSTALLER" 2>&1
}

begin_case non_macos
TIDE_TEST_UNAME=Linux
export TIDE_TEST_UNAME
if output=$(run_installer); then
  fail "non-macOS install is rejected"
else
  assert_contains "non-macOS install is rejected" "supports macOS only" "$output"
fi

begin_case missing_manifest
if output=$(run_installer); then
  fail "missing manifest is rejected"
else
  assert_contains "missing manifest is rejected" "could not download" "$output"
fi

begin_case invalid_manifest
printf '{not valid json\n' > "${TIDE_TEST_DIST}/latest.json"
if output=$(run_installer); then
  fail "invalid manifest is rejected"
else
  assert_contains "invalid manifest is rejected" "not valid JSON" "$output"
fi

begin_case invalid_url
make_release 1.2.3 "" "" "https://example.com/tide-macos-1.2.3.dmg"
if output=$(run_installer); then
  fail "non-GitHub asset URL is rejected"
else
  assert_contains "non-GitHub asset URL is rejected" "unexpected macOS URL" "$output"
fi

begin_case wrong_size
make_release 1.2.3 999999
if output=$(run_installer); then
  fail "size mismatch is rejected"
else
  assert_contains "size mismatch is rejected" "downloaded DMG size" "$output"
fi

begin_case wrong_sha
zero_sha=0000000000000000000000000000000000000000000000000000000000000000
make_release 1.2.3 "" "$zero_sha"
if output=$(run_installer); then
  fail "SHA-256 mismatch is rejected"
else
  assert_contains "SHA-256 mismatch is rejected" "SHA-256 does not match" "$output"
fi

begin_case no_app
make_release 1.2.3
rm -rf "${TIDE_TEST_APP_SOURCE}/Tide.app"
if output=$(run_installer); then
  fail "DMG without Tide.app is rejected"
else
  assert_contains "DMG without Tide.app is rejected" "exactly one Tide.app; found 0" "$output"
fi

begin_case multiple_apps
make_release 1.2.3
make_app "${TIDE_TEST_APP_SOURCE}/Nested/Tide.app" 1.2.3 duplicate
if output=$(run_installer); then
  fail "DMG with multiple Tide.app bundles is rejected"
else
  assert_contains "DMG with multiple Tide.app bundles is rejected" "exactly one Tide.app; found 2" "$output"
fi

begin_case version_mismatch
make_release 1.2.3 "" "" "" 1.2.2
if output=$(run_installer); then
  fail "bundle version mismatch is rejected"
else
  assert_contains "bundle version mismatch is rejected" "mounted app version is 1.2.2" "$output"
fi

begin_case replace_failure_restores
make_release 1.2.3
make_app "${HOME}/Applications/Tide.app" 1.2.2 previous
TIDE_TEST_FAIL_NEW_MOVE=1
export TIDE_TEST_FAIL_NEW_MOVE
if output=$(run_installer); then
  fail "replacement failure exits non-zero"
else
  assert_contains "replacement failure restores the old app" "Restored previous app" "$output"
fi
if [ -f "${HOME}/Applications/Tide.app/Contents/Resources/marker" ] &&
  [ "$(cat "${HOME}/Applications/Tide.app/Contents/Resources/marker")" = "previous" ]; then
  pass "replacement failure leaves the old app in place"
else
  fail "replacement failure leaves the old app in place"
fi
assert_absent "replacement failure does not open the app" "${TIDE_TEST_OPEN_LOG}"

begin_case success_replaces_and_cleans
make_release 1.2.3
make_app "${HOME}/Applications/Tide.app" 1.2.2 previous
if output=$(run_installer); then
  pass "successful install exits zero"
else
  fail "successful install exits zero: $output"
fi
if [ -f "${HOME}/Applications/Tide.app/Contents/Resources/marker" ] &&
  [ "$(cat "${HOME}/Applications/Tide.app/Contents/Resources/marker")" = "tide-1.2.3" ]; then
  pass "successful install replaces the existing app"
else
  fail "successful install replaces the existing app"
fi
assert_contains "successful install opens the installed app" "${HOME}/Applications/Tide.app" "$(cat "$TIDE_TEST_OPEN_LOG" 2>/dev/null || true)"
assert_contains "successful install detaches the DMG" "detach" "$(cat "$TIDE_TEST_HDIUTIL_LOG" 2>/dev/null || true)"
set -- "$TMPDIR"/tide-install.*
if [ -e "$1" ]; then
  fail "successful install removes its temporary directory"
else
  pass "successful install removes its temporary directory"
fi
set -- "${HOME}/Applications"/.tide-install.*
if [ -e "$1" ]; then
  fail "successful install removes its staging directory"
else
  pass "successful install removes its staging directory"
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%d installer test(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\ninstall.sh tests passed\n'
