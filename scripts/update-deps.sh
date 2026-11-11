#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail

WORKSPACE_HACK_MANIFEST="crates/workspace-hack/Cargo.toml"

# Empty the generated section of the hakari workspace-hack manifest so
# `cargo upgrade` cannot rewrite its exact pins to incompatible releases (whose
# feature sets may no longer exist), which would break `cargo metadata` and with
# it every `cargo hakari` subcommand. This edits the text directly rather than
# calling `cargo hakari disable` so it also recovers an already-broken manifest.
clear_workspace_hack() {
  echo "*** Clearing hakari workspace-hack section"
  local cleared
  cleared="$(mktemp)"
  awk '
    /^### END HAKARI SECTION$/ { skipping = 0 }
    !skipping { print }
    /^### BEGIN HAKARI SECTION$/ { skipping = 1 }
  ' "$WORKSPACE_HACK_MANIFEST" >"$cleared"
  cat "$cleared" >"$WORKSPACE_HACK_MANIFEST"
  rm "$cleared"
}

# Regenerate the hakari workspace-hack section against the upgraded dependency
# graph and make sure every workspace member still depends on it. `cargo hakari
# verify` is skipped: the [final-excludes] in .config/hakari.toml make it fail
# by design, so the cargo-hakari pre-commit hook checks the same invariants.
regenerate_workspace_hack() {
  echo "*** Regenerating hakari workspace-hack"
  cargo hakari generate
  cargo hakari manage-deps --yes
}

# Update a module's dependencies: `cargo upgrade` raises the version
# requirements of direct dependencies in its manifests, then `cargo update`
# moves every locked crate (including transitive ones that no manifest names)
# to the newest release those requirements allow. Without the second step the
# lockfile keeps stale transitive versions, which hakari then copies into the
# workspace-hack as exact pins.
update_dependencies() {
  local module="$1"
  echo "*** Updating dependencies for $module"
  pushd "$module" >/dev/null
    cargo upgrade --incompatible
    cargo update
  popd >/dev/null
}

# Print, one per line, the npm packages that must stay on their current
# version: every package with a pnpm patch (patches are keyed to an exact
# version, so moving it makes pnpm abort with ERR_PNPM_UNUSED_PATCH) and every
# direct dependency that package.json pins to an exact version on purpose.
held_js_packages() {
  local patched
  patched="$(pnpm config get patchedDependencies --json)"
  PATCHED_JSON="$patched" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const patched = JSON.parse(process.env.PATCHED_JSON || "null") ?? {};
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const held = new Set(
      Object.keys(patched).map((key) => key.slice(0, key.lastIndexOf("@"))),
    );
    for (const deps of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, version] of Object.entries(deps ?? {})) {
        if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) held.add(name);
      }
    }
    console.log([...held].sort().join("\n"));
  '
}

# Update web UI dependencies to their latest releases, including major
# versions, rewriting the ranges in package.json and the lockfile. Patched and
# exactly pinned packages are excluded so the update never invalidates a patch.
update_js_dependencies() {
  echo "*** Updating pnpm dependencies"
  local held name
  local args=(update --latest)
  held="$(held_js_packages)"
  while IFS= read -r name; do
    [ -n "$name" ] && args+=("!$name")
  done <<<"$held"
  if [ -n "$held" ]; then
    echo "*** Holding patched or pinned packages: ${held//$'\n'/ }"
  fi
  pnpm "${args[@]}"
}

# Rebuild the project after updating dependencies
rebuild_project() {
  echo "*** Rebuilding project"
  cargo build --release
}

# The pnpm update runs first: it is the step most likely to abort (a patch or
# release-age conflict), and failing here leaves the Rust manifests untouched.
update_js_dependencies

clear_workspace_hack
update_dependencies "."
regenerate_workspace_hack

for module in crates/fx-module/examples/*/;do
  update_dependencies "$module"
done

echo -n "Rebuild project ? [y/N] "
read -r answer
if [ "$answer" != "${answer#[Yy]}" ]; then
  rebuild_project
fi
