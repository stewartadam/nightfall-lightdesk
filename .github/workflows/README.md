# Native CI checks and caching

PR descriptions are independently checked by the **Release notes** job in
`release-notes.yml`, including on description edits. See
[PR release notes](../../docs/contributing/release-notes.md) for the `Notes:` convention,
explicit omission syntax, and required-check activation after rollout.

## Security model

Follow [CI trust boundaries](../../docs/ci-security.md): jobs that execute
repository or dependency code have `permissions: {}` and no release secrets.
The read-only `scope` job acquires source and LFS data without executing project
code. Builds consume its credential-free source artifact. Signing and publishing
use fresh runners, consume artifacts only as data, and restore no build caches.
Read-only metadata jobs fetch PR/release API responses; permissionless jobs use
those snapshots to validate descriptions and generate changelogs.
Keep these boundaries intact when adding checks, tools, caches, or release steps.

## Native checks

The application is split into `app-runtime` (shared native runtime and the
`nightfall-headless` executable) and `app-tauri` (the `nightfall-app` desktop
executable, in `desktop/app-tauri`). `app-tauri` is not a default workspace
member, so Clippy and nextest skip it; the native test job and desktop checks
test it explicitly with its default `full,beat-detection` features.

## Distribution selection

The source-acquisition job captures a NUL-delimited PR diff with rename detection
disabled so deleted paths and both sides of a rename are considered. A separate
permissionless job runs the tested policy in `scripts/ci-scope.mjs`. Repository
scripts never execute in the credentialed acquisition job.

| Changes / event | Desktop check | Desktop installers | Browser distribution |
| --- | --- | --- | --- |
| Runtime implementation, runtime tests, ordinary UI changes | No | No | No |
| Desktop shell or shared startup, shutdown, diagnostics interfaces | Yes | No | No |
| Desktop crate manifest, build script, configuration, capabilities, icons | Yes | Yes | No |
| Desktop installer tooling | No (packaging compiles only) | Yes | No |
| Browser runtime or browser packaging tooling | No | No | Yes |
| Shared distribution inputs, root manifests, lockfiles | No (packaging compiles only) | Yes | Yes |
| Draft PR (any changes) | As above | No | As above |
| Main push | No (packaging compiles only) | Yes | Yes |
| Develop push | No | No | No |
| Release tag | No (packaging compiles only) | Yes | No |
| Manual dispatch | No (packaging compiles only) | Selectable | Selectable |

All non-tag events still run native and WebUI validation. The native test job runs
`cargo test -p app-tauri --all-targets` on Linux after nextest, reusing most of the
runtime units it just built. Desktop checks run the same command on macOS and
Windows, without release optimization, frontend generation, or installer creation.
Packaging only compiles `app-tauri`, so a desktop code change selects the check even
when it also selects packaging. A check-only Tauri
configuration clears frontendDist and omits bundled resources, so checks need no
webui/dist output even without a development URL. Packaging validates the actual
frontend and resources using the normal configuration.
The check and release packaging caches are separate.

Desktop checks link test binaries but do not validate the release build or
installers. Full main-branch and
release builds remain the cross-platform packaging backstop. Use manual dispatch
with `desktop`, `browser`, or `all` when an artifact is needed before merging.
Draft PRs never build desktop installers or run the Chromium product flows (the
smoke job and the browser demo's packaged-artifact flows); marking a PR ready for
review re-runs CI with them.
Lockfile selection remains conservative; an ordinary lockfile update selects
both distributions. Release-note-only changes do not select packaging.

PRs that touch `docs/` (or the CI scope policy and workflow) also run the
**Documentation** job, which builds every mdBook under `docs/` with the mdBook
version pinned in `CONTRIBUTING.md`. It fails on missing chapter files and on any
error or warning mdBook logs, such as a broken `{{#include}}`, because mdBook still
exits successfully for those. Drafts run it too; branch pushes and manual dispatches do not.

Keep policy tests in sync with added packaging inputs. Validate them with
`node --test scripts/ci-scope.node.test.mjs`, and validate workflow syntax with
`pnpm exec prek run actionlint --all-files`. Hosted runs are still needed to measure
wall-time improvements and confirm Windows/Linux toolchain behavior.

## Browser previews

Once a preview Worker is configured, every same-repository PR also builds the
browser demo and deploys it as a Cloudflare Workers Preview named `pr-<number>`,
independent of the table above. A preview-only build skips the browser product
flows, which still run whenever the browser distribution is selected. The
`Browser preview` job starts as soon as that build finishes, publishes it at
`https://pr-<number>-<worker>.<subdomain>.workers.dev/demo/app/`, and keeps one
comment on the PR pointing at the latest preview. It is not part of the CI gate.
Fork and Dependabot PRs never build or deploy a preview, since they cannot read
the deployment secret. The job writes a static-assets-only Wrangler config at
deploy time, so the repository carries no Wrangler project.

One-time setup:

1. In Cloudflare, create a Worker to hold the previews. CI never changes its
   production deployment.
2. On the Worker's **Domains** tab, enable the **Preview** URL
   (`*-<worker>.<subdomain>.workers.dev`). On its **Access** tab, require login
   for **All traffic** and allow only the maintainers. Deploys use the API token,
   so Access never blocks CI.
3. Create an API token with only **Account → Workers Scripts → Edit**.
4. In this repository's Actions settings, add the secret
   `CLOUDFLARE_PREVIEW_TOKEN` and the variables `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_PREVIEW_WORKER` (the Worker's name).

Previews stay off while `CLOUDFLARE_PREVIEW_WORKER` is unset. Cloudflare keeps at
most 100 Previews per Worker on the Free plan and 100 deployments per Preview,
deleting the oldest automatically, so no cleanup job is needed.

## Native execution and caching

`ci.yml` runs all native Rust validation in one Linux job so the
dependency graph compiles once per run. The job runs the `cargo-nextest` push hook,
uploads the tested backend for Playwright, then runs the desktop shell tests
(`cargo test -p app-tauri --all-targets`), Rust doctests through the
`manual`-stage `cargo-doctest` hook, and finally the `cargo-clippy` commit hook.
Each later step reuses the build scripts, proc macros and dependencies the test
build produced; Clippy still compiles metadata-only dependency units of its own.
Later steps run even when an earlier one fails, so every result reports. The local
push hook skips doctests because rustdoc processes every library crate. TypeScript
and Node hooks run once in the downstream WebUI job after the shared WASM assets
are available. The browser demo job does not compile native Rust, because the
browser runtime is a default member and its tests already run here.

Jobs cache Cargo state through the [Rust cache action](../actions/rust-cache/README.md),
which wraps `Swatinem/rust-cache`, keys caches on the pinned compiler only, and
reports reused and rebuilt crates in each job summary.

The native job uses a stable shared key, `native`. The key
deliberately omits a manifest hash so a version bump or profile change restores
the newest native cache instead of starting cold.
The action adds runner architecture/OS, toolchain, compiler environment and
Cargo dependency/configuration hashes; it can restore compatible caches from
older lockfiles. Native profile environment variables apply to the whole job,
including cache restore/save and all Cargo commands.

Both `main` and `develop` pushes populate caches visible to PRs targeting those
branches. A PR cache is scoped to that PR and does not warm unrelated PRs.
Develop pushes run validation without desktop/demo packaging. Cache warming
starts once this workflow reaches the base branch; the first run for a new
compiler or profile can still be cold.

The cache retains dependencies and installed Cargo tools using the action's
standard cleanup policy. Workspace artifacts and incremental data are not
persisted. Merely retaining workspace artifacts is insufficient when a fresh
checkout changes source timestamps: Cargo may rebuild them. Workspace-artifact
reuse is deferred pending a verified content-based freshness mechanism for the
pinned toolchain.

Validate syntax with `pnpm exec prek run actionlint --all-files`. On the first hosted
run, confirm that a failure in any native step fails the downstream check. After a
successful base-branch run, a PR with unchanged Rust inputs should report an exact or
partial cache hit with no rebuilt dependencies in its job summary.
