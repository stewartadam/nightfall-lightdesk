#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Exercises the desktop updater against a stand-in update service on localhost, signed with a
# throwaway key, so no published release or release key is involved.
#
#   scripts/test-desktop-updater.sh dev      Check and download in `tauri dev`. Nothing installs.
#   scripts/test-desktop-updater.sh install  Build an installable app and a newer update for it,
#                                            then open the app so About can install the update.
#   scripts/test-desktop-updater.sh serve    Serve the last prepared update again.
#
# Debug builds also offer `nightfallUpdates` in the web inspector console, which shows any update
# state without this service; see docs/desktop-releases.md.
#
# NF_UPDATE_DIR (default /tmp/nf-update) holds the stand-in service, the installed test app and
# the throwaway key. NF_UPDATE_PORT (default 8000) is the port it is served on.

set -euo pipefail

mode=${1:-}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
work=${NF_UPDATE_DIR:-/tmp/nf-update}
port=${NF_UPDATE_PORT:-8000}
key="$work/test.key"
new_version=9.9.9
config=$(printf '{"plugins":{"updater":{"endpoints":["http://localhost:%s/latest.json"],"dangerousInsecureTransportProtocol":true}}}' "$port")

# Prints the generic updater platform key for this machine, e.g. darwin-aarch64.
platform_key() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=aarch64 ;;
    x86_64) arch=x86_64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "$os-$arch"
}

# Creates the passwordless throwaway signing key once, and compiles its public half into every
# build this script starts so the update controls appear and trust only this key.
prepare_key() {
  mkdir -p "$work"
  if [[ ! -f $key ]]; then
    (cd "$repo" && pnpm tauri signer generate --ci -p "" -w "$key")
  fi
  export NIGHTFALL_UPDATER_PUBKEY
  NIGHTFALL_UPDATER_PUBKEY=$(cat "$key.pub")
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
}

# Writes latest.json announcing $new_version for the package $1 inside $work, copying its
# signature verbatim from the .sig file next to it.
write_manifest() {
  python3 - "$work" "$1" "$new_version" "$(platform_key)" "$port" <<'PY'
import json, pathlib, sys
work, package, version, platform, port = sys.argv[1:]
signature = (pathlib.Path(work) / f"{package}.sig").read_text().strip()
manifest = {
    "version": version,
    "pub_date": "2026-01-01T00:00:00Z",
    "platforms": {
        platform: {"url": f"http://localhost:{port}/{package}", "signature": signature}
    },
}
(pathlib.Path(work) / "latest.json").write_text(json.dumps(manifest, indent=2))
PY
}

# Serves $work on $port in the background until this script exits.
serve_in_background() {
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work" >/dev/null 2>&1 &
  server=$!
  trap 'kill "$server" 2>/dev/null' EXIT
}

# Prints cargo's target directory, which may be shared between worktrees.
target_dir() {
  (cd "$repo" && cargo metadata --format-version 1 --no-deps | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
}

case "$mode" in
  dev)
    prepare_key
    # Any file works: the signature is checked, but nothing installs unless you restart.
    head -c 50000000 /dev/urandom > "$work/stand-in.app.tar.gz"
    (cd "$repo" && pnpm tauri signer sign --app-version "$new_version" -f "$key" "$work/stand-in.app.tar.gz")
    write_manifest stand-in.app.tar.gz
    serve_in_background
    echo "Open About and choose Check for Updates. Don't restart to update: the stand-in isn't an app."
    (cd "$repo" && pnpm tauri dev --config "$config")
    ;;
  install)
    [[ $(uname -s) == Darwin ]] || { echo "install mode builds a macOS .app" >&2; exit 1; }
    prepare_key
    bundle_dir="$(target_dir)/debug/bundle/macos"
    # The current version, installed into $work. The next build writes to the same folder.
    (cd "$repo" && pnpm tauri build --debug --bundles app --config "$config")
    rm -rf "$work/Nightfall.app"
    cp -R "$bundle_dir/Nightfall.app" "$work/"
    # The newer version as an updater package. `tauri build` signs it and binds the signature
    # to $new_version, which the app requires. It verifies that signature against the config's
    # pubkey, which tauri.conf.json leaves empty because the app takes the key at compile time.
    (cd "$repo" && TAURI_SIGNING_PRIVATE_KEY=$(cat "$key") pnpm tauri build --debug --bundles app \
      --config "$config" \
      --config "{\"version\":\"$new_version\",\"bundle\":{\"createUpdaterArtifacts\":true},\"plugins\":{\"updater\":{\"pubkey\":\"$NIGHTFALL_UPDATER_PUBKEY\"}}}")
    cp "$bundle_dir/Nightfall.app.tar.gz" "$bundle_dir/Nightfall.app.tar.gz.sig" "$work/"
    cp -R "$work/Nightfall.app" "$work/Nightfall-old.app.backup"
    write_manifest Nightfall.app.tar.gz
    echo "Opening $work/Nightfall.app. In About, check, download, then Restart to update"
    echo "(or choose 'Download and install on quit' and quit). About should then show $new_version."
    echo "Run '$0 serve' to test again; it restores the old app first. Ctrl-C stops the service."
    open "$work/Nightfall.app"
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work"
    ;;
  serve)
    [[ -f $work/latest.json ]] || { echo "Run dev or install first." >&2; exit 1; }
    if [[ -d $work/Nightfall-old.app.backup ]]; then
      rm -rf "$work/Nightfall.app"
      cp -R "$work/Nightfall-old.app.backup" "$work/Nightfall.app"
      open "$work/Nightfall.app"
    fi
    echo "Serving $work on port $port. Ctrl-C stops it."
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work"
    ;;
  *)
    sed -n '9,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
