# CI builds

`ci-precommit.yml` acquires credential-free source and LFS assets in a read-only
job, then runs all builds/tests with `permissions: {}` and no release secrets.
The shared `wasm.yml` workflow builds the bridge and browser runtime separately.
`desktop-artifacts.yml` validates version policy, builds the desktop frontend,
and shares it with the native packaging jobs. `browser-demo.yml` downloads the
same WASM artifacts and builds its own Vite output with the demo mode and base
path. The two distributions retain separate notices and packaging.

Only version-tag pushes enter `release.yml`: fresh runners sign/notarize the
macOS app and publish the complete installer set. These jobs treat artifacts as
data, never execute project/dependency code, and restore no build caches. Keep
execution and release authority in separate jobs, not just separate steps. See
the repository's [CI trust-boundary design](https://github.com/stewartadam/nightfall-lightdesk/blob/main/docs/ci-security.md)
for the threat model, source handoff, and artifact validation rules.

`npm run build:browser-demo` builds WASM before packaging for local use.
`npm run build:browser-demo:prepared` requires both generated WASM packages in
`webui/assets`; CI uses it after downloading the same-run artifact. Development
WASM and a redundant wasm32 check are not needed in the release pipeline. The
precommit workflow also consumes the shared release WASM artifacts.

Browser manifests record raw byte sizes, SHA-256 hashes, and SHA-384 integrity.
The size report uses packaged file sizes. Neither script compresses assets to
estimate transfer size; actual HTTP compression belongs to the hosting service.

`run-native-cargo.mjs` selects the same static workspace feature graph for
Clippy, workspace tests, and the Playwright backend. It explicitly retains the
app's full and beat-detection features and the flow crate's default FX-module
feature, while excluding dynamic Bevy linking. Local default application builds
remain unchanged. When adding workspace default features, update this selection.
The backend build and the `cargo nextest` run both select `--tests`, so they share
dev-dependency feature unification and compiled units. Already-built test
harnesses are reused; final executable linking still requires distinct Cargo
work. No test gate builds or links examples; Clippy only type-checks them, so a
link-time failure specific to an example goes unnoticed. Doctests run separately
through `cargo test --doc`, because nextest does not execute them.

CI runs nextest with the `ci` profile from `.config/nextest.toml`, which reports
every failure instead of stopping at the first, and uploads
`target/nextest/ci/junit.xml` as the `rust-test-junit-<commit SHA>` artifact for
per-test timings. Doctests run after the backend artifact is uploaded, so they
do not delay browser tests, and they still run when nextest fails.
