# Native CI checks and caching

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
