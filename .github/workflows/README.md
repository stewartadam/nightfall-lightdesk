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
executable). Native validation excludes `app-tauri`; desktop checks explicitly
enable its `full,beatgrid-detect` features.

## Distribution selection

The source-acquisition job captures a NUL-delimited PR diff with rename detection
disabled so deleted paths and both sides of a rename are considered. A separate
permissionless job runs the tested policy in `scripts/ci-scope.mjs`. Repository
scripts never execute in the credentialed acquisition job.

| Changes / event | Desktop check | Desktop installers | Browser distribution |
| --- | --- | --- | --- |
| Runtime implementation, runtime tests, ordinary UI changes | No | No | No |
| Desktop shell or shared startup, shutdown, diagnostics interfaces | Yes | No | No |
| Desktop configuration, capabilities, icons, installer tooling | Included in packaging | Yes | No |
| Browser runtime or browser packaging tooling | No | No | Yes |
| Shared distribution inputs, root manifests, lockfiles | Included in packaging | Yes | Yes |
| Main push | Included in packaging | Yes | Yes |
| Develop push | No | No | No |
| Release tag | Included in packaging | Yes | No |
| Manual dispatch | Included when desktop selected | Selectable | Selectable |

All non-tag events still run native and WebUI validation. Desktop checks use
`cargo check --all-targets` on macOS, Windows, and Linux, without release
optimization, frontend generation, or installer creation. A check-only Tauri
configuration clears frontendDist and omits bundled resources, so checks need no
webui/dist output even without a development URL. Packaging validates the actual
frontend and resources using the normal configuration.
The check and release packaging caches are separate.

Compilation checks do not validate linking or installers. Full main-branch and
release builds remain the cross-platform packaging backstop. Use manual dispatch
with `desktop`, `browser`, or `all` when an artifact is needed before merging.
Lockfile selection remains conservative; an ordinary lockfile update selects
both distributions. Release-note-only changes do not select packaging.

Keep policy tests in sync with added packaging inputs. Validate them with
`node --test scripts/ci-scope.node.test.mjs`, and validate workflow syntax with
`npx prek run actionlint --all-files`. Hosted runs are still needed to measure
wall-time improvements and confirm Windows/Linux toolchain behavior.

## Native execution and caching

`ci-precommit.yml` runs the native pre-commit stage (Clippy and source checks)
and pre-push stage (Rust tests) as parallel matrix jobs with `fail-fast: false`.
Each stage runs once. Both skip TypeScript and Node hooks, which run once in the
downstream WebUI job after the shared WASM assets are available. Only the native
test job builds and uploads the tested backend for Playwright. The existing
`Run prek hooks` check still requires both native stages and both WASM builds
to succeed before running WebUI validation.

Each native stage uses a stable, separate `Swatinem/rust-cache` shared key:
`native-pre-commit` and `native-pre-push`, suffixed with a hash of the root
manifest and shared native Cargo command wrapper. This also refreshes caches
when workspace profile settings or selected features change. This prevents parallel jobs from
competing to save the same immutable key with different compiler artifacts.
The action adds runner architecture/OS, toolchain, compiler environment and
Cargo dependency/configuration hashes; it can restore compatible caches from
older lockfiles. Native profile environment variables apply to the whole job,
including cache restore/save and all Cargo commands. Optimization settings and
hook coverage are unchanged.

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
pinned toolchain. Parallel execution reduces wall time at the cost of additional
runner work, and no particular speedup is assumed until measured on GitHub.

Validate syntax with `npx prek run actionlint --all-files`. On the first hosted
run, confirm that both native jobs overlap, only the test job uploads
`native-test-backend`, and failures in either stage fail the downstream check.
After a successful base-branch run, a PR with unchanged Rust inputs should report
restored caches in both native jobs and avoid rebuilding unchanged dependencies.
