#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail

# Update dependencies for all modules in the project
update_dependencies() {
  local module="$1"
  echo "*** Updating dependencies for $module"
  pushd "$module" >/dev/null
    cargo upgrade --incompatible
  popd >/dev/null
}

# Update web UI dependencies to their latest releases, including major
# versions, rewriting the ranges in package.json and the lockfile
update_js_dependencies() {
  echo "*** Updating pnpm dependencies"
  pnpm update --latest
}

# Rebuild the project after updating dependencies
rebuild_project() {
  echo "*** Rebuilding project"
  cargo build --release
}

update_dependencies "."
update_dependencies "crates/cli"

for module in crates/fx-module/examples/*/;do
  update_dependencies "$module"
done

update_js_dependencies

echo -n "Rebuild project ? [y/N] "
read -r answer
if [ "$answer" != "${answer#[Yy]}" ]; then
  rebuild_project
fi
