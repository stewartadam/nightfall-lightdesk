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

`run-native-cargo.mjs` selects one runtime workspace feature graph, using every
crate's default features and excluding `app-tauri`, for Clippy, workspace tests,
the worktree dashboard backend (`run`), and the Playwright backend. The backend
build includes test targets to retain the same dev-dependency feature
unification as the test run; `cargo run` cannot select the workspace or its dev
dependencies, so the `run` subcommand builds with that graph and then launches
the executable. Already-built test harnesses are reused; final executable
linking still requires distinct Cargo work.
