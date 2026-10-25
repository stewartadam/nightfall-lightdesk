#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Provisions Claude Code cloud containers with the toolchain this repository
# pins. The cloud image ships a stable-only rustup and a Playwright browser
# build that predates our @playwright/test version, so without this the first
# parallel cargo calls race rustup's auto-install (leaving the nightly without
# cargo) and native Playwright specs launch the wrong Chromium.
#
# Local sessions exit immediately; CONTRIBUTING.md covers local setup.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# SessionStart stdout is injected into the model context; keep install logs out.
exec >&2

# Cloud sessions have a fixed disk allowance that one test build nearly halves.
# Incremental caches (~5 GB per build, growing with every edit) are not worth it
# in a short-lived container, and zlib-compressed debug sections roughly halve
# each test binary while keeping backtrace line numbers (std cannot read zstd).
# Scoped to the host target so wasm32 builds keep their default linker flags.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  cat >>"$CLAUDE_ENV_FILE" <<'EOF'
export CARGO_INCREMENTAL=0
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C link-arg=-Wl,--compress-debug-sections=zlib"
EOF
fi

# The clone carries LFS pointers only; lint and the demo show need the files.
git lfs pull

# Install the rust-toolchain.toml toolchain (with cargo, components and
# targets) once, before anything can trigger concurrent auto-installs.
rustup toolchain install

# Native backend builds link alsa-sys.
if ! dpkg -s libasound2-dev >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libasound2-dev
fi

pnpm install --frozen-lockfile

# Run the same quality gates on commit and push as local checkouts. prek keeps
# the clone's Git LFS hooks as chained legacy hooks.
pnpm exec prek install -t pre-commit -t commit-msg -t pre-push -t post-merge -t post-rewrite

# pnpm switches to the packageManager version without running that wrapper's
# install script, leaving a shebang-less placeholder at its `pnpm` bin. Shells
# retry it, but the shell emulator behind nested `pnpm run` gets ENOEXEC.
pnpm_bin=$(pnpm exec sh -c 'command -v pnpm')
if ! head -c 4 "$pnpm_bin" | grep -q 'ELF'; then
  (cd "$(dirname "$pnpm_bin")/../node_modules/pnpm" && node install.js)
fi

# The image sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 and points
# PLAYWRIGHT_BROWSERS_PATH at its preinstalled browsers; fetch the revisions
# our pinned Playwright expects into that same directory.
env -u PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD pnpm run playwright:install

# The pre-push hook runs Rust tests through nextest; match CI's pinned version.
nextest_version=$(jq -r '."cargo-nextest"' config/cargo-tools.json)
if ! cargo nextest --version 2>/dev/null | grep -qF "cargo-nextest $nextest_version "; then
  curl -fsSL "https://get.nexte.st/$nextest_version/linux" | tar zxf - -C "$HOME/.cargo/bin"
fi

pnpm run setup:tools typeshare-cli

if [ ! -f .env ]; then
  node scripts/setup-env.mjs
fi
