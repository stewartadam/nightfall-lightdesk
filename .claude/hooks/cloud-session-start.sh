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

# Containers have no GPU, so Chromium falls back to SwiftShader and the
# visualizer renders at about 1 FPS, timing out its specs. ANGLE on Mesa's
# llvmpipe (through EGL) reaches about 10 FPS on the same cores. Leave WebGPU
# off: Dawn only offers SwiftShader there, which is slower still.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  cat >>"$CLAUDE_ENV_FILE" <<'EOF'
export NIGHTFALL_PLAYWRIGHT_CHROMIUM_ARGS="--use-angle=gl-egl --ignore-gpu-blocklist"
EOF
fi

# The clone carries LFS pointers only; lint and the demo show need the files.
git lfs pull

# Install the rust-toolchain.toml toolchain (with cargo, components and
# targets) once, before anything can trigger concurrent auto-installs.
rustup toolchain install

# Native backend builds link alsa-sys; ANGLE loads Mesa's EGL and GLES
# libraries for the llvmpipe launch flags above.
apt_packages=(libasound2-dev libegl1 libegl-mesa0 libgles2)
if ! dpkg -s "${apt_packages[@]}" >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt_packages[@]}"
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

# Beads issues live in a Dolt database on a maintainer-only remote, named by
# the cloud environment's BEADS_SYNC_REMOTE variable so it stays out of this
# repository. The data sits under a claude/ branch ref rather than Dolt's
# default refs/dolt/data because cloud sessions may only push branches. bd
# cannot pick a git ref itself, so the dolt CLI clones the database into the
# layout bd's embedded mode expects; its pull/push then reuse the clone's ref.
# A failed clone only costs issue tracking, so it must not fail the session.
# Keep bd in step with maintainers' machines: a newer bd can migrate the shared
# database's schema past what older clients read.
if [ -n "${BEADS_SYNC_REMOTE:-}" ]; then
  bd_version=1.3.4
  dolt_version=2.7.2
  if ! bd version 2>/dev/null | grep -qF "bd version $bd_version "; then
    npm install -g "@beads/bd@$bd_version"
  fi
  if ! dolt version 2>/dev/null | grep -qF "dolt version $dolt_version"; then
    curl -fsSL "https://github.com/dolthub/dolt/releases/download/v$dolt_version/dolt-linux-amd64.tar.gz" |
      tar xzf - -C /usr/local --strip-components=1 dolt-linux-amd64/bin/dolt
  fi
  # A resumed container already holds a clone, so pull what changed since
  # instead. beads-push.sh pushes writes at each turn end.
  if [ ! -d .beads/embeddeddolt/beads ]; then
    mkdir -p -m 700 .beads/embeddeddolt
    printf '{"database":"dolt","backend":"dolt","dolt_mode":"embedded","dolt_database":"beads"}\n' >.beads/metadata.json
    printf 'sync.remote: "%s"\n' "$BEADS_SYNC_REMOTE" >.beads/config.yaml
    dolt clone --ref refs/heads/claude/beads-data "$BEADS_SYNC_REMOTE" .beads/embeddeddolt/beads ||
      echo "beads clone failed; bd issues are unavailable this session" >&2
  else
    bd sync || echo "bd sync failed; beads issues may be stale" >&2
  fi
fi
