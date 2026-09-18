<!-- markdownlint-disable MD033 -->
# Contributing <!-- omit in toc -->

For desktop artifact builds and the tagged-release procedure, see [Desktop builds and releases](docs/desktop-releases.md).

- [Legal](#legal)
- [Getting started](#getting-started)
  - [Required setup](#required-setup)
    - [General dependencies](#general-dependencies)
    - [macOS](#macos)
    - [Linux](#linux)
    - [Windows](#windows)
    - [Nightfall setup](#nightfall-setup)
    - [Git hooks](#git-hooks)
    - [Optional tools](#optional-tools)
  - [Running Nightfall](#running-nightfall)
  - [Quality checks and browser tests](#quality-checks-and-browser-tests)
  - [Building the documentation](#building-the-documentation)
  - [Validating showfile restore idempotency](#validating-showfile-restore-idempotency)
  - [Debugging command parser](#debugging-command-parser)
  - [Performance profiling](#performance-profiling)

## Legal

Contributions are welcome under the project's [license](LICENSE). Before a contribution can be merged, contributors must accept the [Nightfall Contributor License Agreement (CLA)](https://cla-assistant.io/stewartadam/nightfall-lightdesk) through the project's CLA service and sign off each commit under the [Developer Certificate of Origin (DCO)](https://developercertificate.org/). These are separate requirements: the DCO attests to your right to submit the contribution, while the CLA grants the maintainer rights to use and license it.

A CLA can look intimidating. Its purpose is to make long-term maintenance practical: as a codebase and its contributor community grow, tracking permissions and contacting every past contributor for a license change can become difficult or impossible. The CLA establishes those permissions up front, including the ability to relicense contributions or offer multiple licenses. You retain ownership and can use and license your own contributions independently; the maintainer can also license them under open-source, commercial, or proprietary terms without seeking further permission or owing payment. Third-party material remains subject to its own license.

Please read the linked CLA and DCO before contributing. Those documents contain the full terms; we link to their maintained versions rather than duplicate them here.

To attest to the DCO, add a sign-off to each commit using your configured Git identity:

```sh
git commit -s -m "commit message"
```

This adds a trailer in the following format:

```text
Signed-off-by: Your Name <Your@Email.tld>
```

First-party source files must include the `SPDX-License-Identifier: MPL-2.0`
comment and Mozilla MPL 2.0 notice. The `insert-license` prek hook checks the
complete header using the templates in `config/license-headers/`. When a header
is missing, the hook inserts it and stops the commit so you can inspect and stage
the change. Script shebangs remain first. Imported third-party code retains its
original license; the framepace source file is explicitly excluded.

Run `npx prek run insert-license --all-files` to check all tracked source files.

## Getting started

### Required setup

#### General dependencies

Install Git, [rustup](https://rustup.rs/), and **Node.js 24 with npm**, matching `.nvmrc` and the CI environment (`nvm install && nvm use` if you use nvm). Keep `package-lock.json` and `Cargo.lock`; use `npm ci` and Cargo's `--locked` flag to reproduce their dependency versions.

Rustup reads `rust-toolchain.toml`, which pins the nightly compiler and installs rustfmt, Clippy, and the `wasm32-unknown-unknown` target. Do not substitute a stable compiler or set `RUSTUP_TOOLCHAIN` when validating a change. Update the pin deliberately with native and WASM validation.

Install the command-line type generator used by `npm run typeshare`:

```sh
cargo install --locked typeshare-cli --version 1.13.3
```

Vite, Tauri CLI, wasm-pack, Playwright, and prek are project npm dependencies; `npm ci` installs them. No global npm packages are required for an ordinary contribution.

#### macOS

Install Apple's command-line developer tools for the native linker and SDK:

```sh
xcode-select --install
```

#### Linux

On Ubuntu/Debian, install the native build and audio dependencies. GTK and WebKit are also needed for the desktop application and the repository's Tauri-inclusive checks:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libasound2-dev libgtk-3-dev libwebkit2gtk-4.1-dev
```

Other distributions need the equivalent development packages. For browser tests, install Chromium and Firefox and their Linux system dependencies through the repository wrapper after `npm ci`:

```sh
npm run playwright:install -- --with-deps
```

#### Windows

Install the MSVC linker and Windows SDK using Visual Studio Build Tools with the **Desktop development with C++** workload:

```cmd
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"
```

The desktop shell also requires the Microsoft Edge WebView2 runtime. Use **Git Bash** for the shell commands in this guide. Several npm scripts use POSIX environment-variable syntax, so configure npm to run scripts with Bash too (adjust the path for your Git installation):

```sh
npm config set script-shell "C:\\Program Files\\Git\\bin\\bash.exe" --location=user
```

This changes npm's script shell for your Windows user; launching npm from Git Bash alone does not change its default script shell. In PowerShell, `npm.cmd` avoids the execution-policy restriction on `npm.ps1`; a machine-wide execution-policy change is unnecessary.

#### Nightfall setup

From the repository root of a fresh clone:

```sh
rustup show
npm ci
node scripts/setup-env.mjs
npm run download:beat-this-model
npm run typeshare
npm run wasm-build:dev
cargo build --workspace --locked
```

Production web and Tauri builds generate dependency notices. Install their
pinned collector with `cargo install cargo-about --locked --version 0.8.4`.
See [distribution notices](docs/src/developer-reference/distribution-notices.md)
for packaging and dependency-update requirements.

Run `cargo install --locked typeshare-cli --version 1.13.3` first if you have not already installed the generator. `setup-env.mjs` creates the ignored `.env` and `.cargo/config.toml`; it chooses a backend port, configures the shared Playwright browser location, and enables the Cargo settings expected by the build. It overwrites those files, so run it once for a new checkout rather than over an environment you have customized.

The backend port is `NIGHTFALL_PORT` in `.env`; Vite uses the following port. For example, `NIGHTFALL_PORT=3544` gives a web UI at `http://localhost:3545`. Keep the existing Cargo target directory, including when another worktree is building. A build lock means another build is using those artifacts.

The WASM build generates both the application bridge and worker-local browser runtime, including its curated component FX artifact. Generated WASM assets and TypeScript types are prerequisites for running the UI from a clean checkout.

Beatgrid detection uses a Rust mel-spectrogram frontend and the MIT-licensed Beat This model pipeline with RTen. The model downloader verifies the checksum and writes `webui/assets/models/beat-this/beat_this.onnx`; license details are in `webui/assets/models/beat-this/NOTICE.md`. This step requires a network connection and is separate from `npm ci`.

A clean clone does not include a personal fixture or object library. Put compatible fixture definitions in the application's data directory, as described in the [Fixture Library guide](docs/src/user-guide/panels/fixture-library.md). Set `NIGHTFALL_DATA_DIR` in `.env` to an isolated writable directory for development. Use `NIGHTFALL_SAMPLE_DATA=1` when you intentionally want the engine's generated sample show data; do not enable it against a show you intend to preserve unchanged.

Worktrunk is optional. `wt switch --create <branch>` runs the repository hooks to create the environment, install packages, generate types/assets, and seed build and application data from the main worktree. These hooks assume the general prerequisites above are installed. Check their output before starting services; a background build may still be running.

#### Git hooks

This project uses [prek](https://prek.j178.dev) to enforce quality gates during development.

```sh
npx prek install -t pre-commit -t pre-push -t post-merge -t post-rewrite
```

If you wish to also use beads, ensure hooks are chained:

```sh
npm install -g @beads/bd
bd hooks install --chain
```

#### Optional tools

```sh
# expands macros
cargo install --locked cargo-expand

# performance profiling
cargo install --locked samply
cargo install cargo-samply

cargo install --git https://github.com/rust-lang/measureme --branch stable summarize
cargo install --git https://github.com/rust-lang/measureme --branch stable crox

# show unused dependencies
cargo install cargo-udeps

# automatically upgrade packages
cargo install cargo-edit

# cleanup cache
cargo install cargo-sweep
cargo install cargo-cache
```

In the future these Cargo commands can be updated with:

```sh
cargo install cargo-update
cargo install-update -a
```

### Running Nightfall

By default the terminal-only session is run with a dynamically-linked Bevy for faster compile times.
The backend engine can be started by simply running `cargo run`, and the web UI with `npm run dev`.

Playwright test commands use a pool of up to six parallel workers by default;
set `NIGHTFALL_PLAYWRIGHT_WORKERS` to choose another pool size. Each worker keeps a
Vite proxy on a temporary loopback port pair, while every test starts a freshly
seeded backend on that worker's backend port. The run sanitizes one seed copy,
then uses copy-on-write filesystem clones for each test when supported. The seed
includes only the stable `default`, `sample`, fixture-library, FX-module, and
object-library data from the worktree's `NIGHTFALL_DATA_DIR`, with physical
transports initially disabled. This keeps tests from mutating a developer
session or inheriting backend world and undo state from another test. Owned
services and disposable data are removed after each test and swept again when
Playwright exits.

Pass `--target embedded-demo` to run browser-demo tests without building or
starting the native backend. The default target is `native`, which can also be
selected explicitly with `--target native`:

```sh
npm run test:webui-playwright -- --target embedded-demo webui/e2e/browser-demo.spec.ts
```

Pass `--rust-log` through the repository wrapper to set the backend's Rust log
filter for one run. The wrapper consumes this option and forwards the remaining
arguments to Playwright:

```sh
npm run test:webui-playwright -- --rust-log 'nightfall_websocket=trace,nightfall_fx::events=trace,warn' webui/e2e/step-fx-editor.spec.ts --grep 'first-release authoring workflow'
```

Pass `--data-dir` to select the source data directory used to seed a test run
without exporting `NIGHTFALL_DATA_DIR`. The run still copies the stable seed data
into its disposable data root:

```sh
npm run test:webui-playwright -- --data-dir /tmp/nightfall-sample-blueprints webui/e2e/sample-blueprints-visual.spec.ts
```

If you run multiple git worktrees in parallel, start the dashboard API with:

```sh
npm run worktree:dashboard
```

For API hot-reload while editing `worktree-dashboard/worktree-dashboard.mjs`, use:

```sh
npm run worktree:dashboard:watch
```

Then start the Solid/Vite dashboard UI (with HMR) in a separate shell:

```sh
npm run worktree:dashboard:ui
```

The dashboard page is served at `/worktree-dashboard.html` and calls the API via Vite proxy (`/worktree-api`).
The API discovers all worktrees from `git worktree list`, reads each `.env` (`NIGHTFALL_PORT`), and provides launch/recycle controls plus direct links to each Web UI.

To run the backend and Art-Net/sACN sender examples through a Cargo wrapper such
as Mr Boxington, set `NIGHTFALL_CARGO_COMMAND=mbx` in the target worktree's `.env`.
Each service launch reads that worktree's settings, including variable expansion,
and applies them over the environment inherited when the dashboard started.
An exported value provides a fallback for worktrees that do not configure it:

```sh
NIGHTFALL_CARGO_COMMAND=mbx npm run worktree:dashboard
```

The default is `cargo` (`cargo.exe` on Windows). The value must be one executable
name on the dashboard's `PATH`, or an absolute executable path, without arguments
or shell syntax. For example, `mbx` launches the backend with `mbx run`. Start and
recycle use the same configured command, which is included in service logs;
a missing executable produces a process error without falling back to Cargo.
Start or recycle the worktree service after changing its `.env`; restarting the
dashboard is unnecessary. The dashboard loads its own host and port settings from
its startup directory's `.env`, but does not pass those dotenv values to other
worktrees. UI and WASM builds still launch through npm with their worktree's
environment.

New worktrees seed their `.env` from the primary worktree's `.env`, preserving
its settings and comments. Setup then appends the generated port and shared
Playwright browser path, plus the isolated data directory and disabled network
input/output settings for secondary worktrees. These generated values override
the inherited settings. If the primary `.env` is missing, setup uses only the
generated settings. Later edits to the primary `.env` do not update existing
worktrees.

Agents can also manage their own worktree lifecycle through MCP (for example, from Codex/Claude) by running:

```sh
npm run worktree:mcp
```

The MCP server talks to the dashboard API, so keep `npm run worktree:dashboard` running while agents are connected.
It targets dashboard address `http://127.0.0.1:4780` by default.
You can override with:

- `NIGHTFALL_WORKTREE_DASHBOARD_URL` (full URL, takes precedence)
- `NIGHTFALL_WORKTREE_DASHBOARD_HOST` / `NIGHTFALL_WORKTREE_DASHBOARD_PORT`

Use `dashboard_list_worktrees` to get paths, then pass a `worktree` path explicitly to:

- `dashboard_worktree_status`
- `dashboard_worktree_manage`
- `dashboard_sender_examples_status`
- `dashboard_sender_examples_manage`

`dashboard_worktree_manage` supports `services=[backend|ui|wasm|artnet-sender|sacn-sender|all,...]`.
Use `dashboard_sender_examples_manage` for a sender-focused API with
`senders=[art-net|sacn|all,...]`.

Example MCP config:

```json
{
  "mcpServers": {
    "nightfall-worktree-dashboard": {
      "command": "npm",
      "args": ["run", "worktree:mcp"],
      "cwd": "/absolute/path/to/your/main-repo"
    }
  }
}
```

To start the application with Tauri, dynamic linking must be disabled (see [bevyengine/bevy#3856](https://github.com/bevyengine/bevy/issues/3856)) and the `tauri` feature should be enabled:

```sh
npx tauri dev --features full,tauri,beatgrid-detect -- --no-default-features
```

### Quality checks and browser tests

Run the checks relevant to your change:

```sh
npm run lint
npm run typecheck
npm run check:command-architecture
npm run check:crate-boundaries
npm test
cargo fmt --all -- --check
cargo clippy --all-targets --locked
cargo test --workspace --locked
```

After changing Rust command parsing or shared types, regenerate with `npm run typeshare` and `npm run wasm-build:dev` before browser validation. Commit and push hooks also run applicable checks and may take several minutes; let them finish and correct failures before retrying.

Install test browsers once per shared browser cache:

```sh
npm run playwright:install
```

On Linux use the `--with-deps` form in the Linux setup section. Run browser tests only through the repository wrapper, which reads `.env` and manages isolated backend data and services:

```sh
npm run test:webui-playwright -- webui/e2e/command-palette.spec.ts
npm run test:webui-playwright -- --headed webui/e2e/clip-go-button.spec.ts
```

Use `--grep` to select a scenario and `--workers=1` to reduce concurrent load. Inspect screenshots and traces under `test-results/playwright/`; verify the visible result, not just command acknowledgements. Stop timeline playback at the end of a test that starts it. The wrapper disables timeline audio during its test runs.

### Building the documentation

The user-facing manual is an mdBook in `docs/`. Its navigation lives in `docs/src/SUMMARY.md`; add a navigation entry for every new user-facing page. The [panel guide](docs/src/user-guide/panels/index.md) covers first-release panels, with Flows excluded.

```sh
cargo install --locked mdbook --version 0.4.49
mdbook build docs
mdbook serve docs --open
```

Internal design decisions, BRDs, and developer reference live in a separate mdBook in `docs/internal/`, with navigation in `docs/internal/src/SUMMARY.md`. Keep internal content in that source tree so it is excluded from the user manual, including its search index and downloadable output.

```sh
mdbook build docs/internal
mdbook serve docs/internal --port 3001 --open
```

Add `{{#include ../includes/human-review-disclaimer.md}}` immediately below the title of new user-guide pages (use `../../includes/` for panel pages). Keep this shared disclaimer on each page until a human has reviewed its accuracy and completeness, then remove the include from that page.

Check rendered pages and local links after edits. The generated `docs/book/` and `docs/internal/book/` directories are ignored and should not be committed. Build each book into a clean output directory when validating or publishing so stale pages from previous builds are not retained. Keep the getting-started tutorial aligned with actual labels and commands, and validate changed workflows with the Playwright wrapper.

### Validating showfile restore idempotency

Use this flow to validate that `save -> restart -> load -> save` restores identical persisted state:

If your default app data directory is not writable in your environment, set
`NIGHTFALL_DATA_DIR` to a writable path for all commands below (for example
`NIGHTFALL_DATA_DIR=/tmp/nightfall-dev`).

1. Seed and save

```sh
NIGHTFALL_SAMPLE_DATA=1 cargo run -p nightfall-app
```

Then run `save`, followed by `quit`.

2. Restart without sample data and load

```sh
NIGHTFALL_SAMPLE_DATA=0 cargo run -p nightfall-app
```

Then run `load`, wait for restart, then run `save`, followed by `quit`.

3. Verify roundtrip parity

```sh
./scripts/verify_showfile_roundtrip.sh
```

Expected result: script prints `ok: normalized showfile JSON matches backup snapshot`.
If it reports differences, inspect the JSON diff output and treat as a regression in save/load behavior.

### Debugging command parser

Command parsing uses `logos` for tokenization and the strict parser in `nightfall-cmd-parse` for command parsing.
Useful workflows when changing the parser:

```sh
# parser + AST + command conversion tests
cargo test -p nightfall-cmd-parse

# autocomplete behavior/spec tests
cargo test -p nightfall-cmd-parse --test autocomplete

# command validation diagnostics tests
cargo test -p nightfall-cmd-parse --test validation
```

### Performance profiling

For long samples (>15s) the profiler might crash while loading data.
Consider reducing the sample rate with `-r sample_hz` if running a long profiling session.

```sh
cargo build --profile profiling
samply record cargo run --profile profiling --bin nightfall-app "$@"
```

Clip lookup scaling has a Criterion suite covering snapshot construction,
direct-query crossover, and independently sized persistent and active clip
sets. The default defined-clip matrix extends through 10,000 definitions:

```sh
cargo bench -p nightfall-desk --bench clip_lookup
```

Use comma-separated environment overrides for a focused run:

```sh
NIGHTFALL_CLIP_BENCH_DEFINED_COUNTS=1000,5000 \
NIGHTFALL_CLIP_BENCH_LOOKUP_COUNTS=1,8,64 \
NIGHTFALL_CLIP_BENCH_ACTIVE_COUNTS=0,16,64 \
cargo bench -p nightfall-desk --bench clip_lookup
```
