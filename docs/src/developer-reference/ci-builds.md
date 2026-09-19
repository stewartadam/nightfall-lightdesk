# CI builds

`desktop-artifacts.yml` coordinates distribution builds. Its prepare job checks
version policy and the browser dependency graph, builds the release WASM bridge
and browser runtime once, and uploads `release-wasm-<commit>` with both generated
packages. Desktop Vite assets are built in that job and shared with all native
installer jobs. The reusable `browser-demo.yml` workflow downloads the same WASM
artifact, then builds its own Vite output with the demo mode and base path.
The two distributions retain separate notices and packaging.

`npm run build:browser-demo` builds WASM before packaging for local use.
`npm run build:browser-demo:prepared` requires both generated WASM packages in
`webui/assets`; CI uses it after downloading the same-run artifact. Development
WASM and a redundant wasm32 check are not needed in the release pipeline. The
precommit workflow retains development WASM for its independent checks.

Browser manifests record raw byte sizes, SHA-256 hashes, and SHA-384 integrity.
The size report uses packaged file sizes. Neither script compresses assets to
estimate transfer size; actual HTTP compression belongs to the hosting service.

`run-native-cargo.mjs` selects the same static workspace feature graph for
Clippy, workspace tests, and the Playwright backend. It explicitly retains the
app's full and beat-detection features and the flow crate's default FX-module
feature, while excluding dynamic Bevy linking. Local default application builds
remain unchanged. When adding workspace default features, update this selection.
The backend build includes test targets to retain the same dev-dependency feature
unification as the test run. Already-built test harnesses are reused; final
executable linking still requires distinct Cargo work.
