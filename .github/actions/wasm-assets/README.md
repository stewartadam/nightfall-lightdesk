# Cached WASM assets

Run after checkout, Node/Rust setup and `npm ci`. The action builds or restores
the selected wasm-pack package, including generated JavaScript, TypeScript declarations
and the final optimized WASM binaries. Development and release builds use separate
keys. The existing Cargo cache still accelerates cache misses.

Only exact matches are restored. Keys include the compiler identity, runner OS
and architecture, profile, Cargo manifests/lockfile, whole crate trees, Cargo
configuration, shared configuration and fixtures, build scripts, npm manifests
and lockfile, license, workflows and this action. This deliberately favors extra
misses over stale binaries: even unrelated native crate changes invalidate the
cache. Add any future build inputs outside these paths to the key. Build settings
must remain in the hashed repository configuration/workflows.

The action checks the package's entry points and saves successful builds before
later frontend builds or tests run. Per-commit release artifacts are still
uploaded normally, including on cache hits; only the generated WASM is reused,
so frontend build metadata and distribution notices remain fresh.

`wasm.yml` publishes each release package once per run. The CI workflow starts
parallel native Clippy/test checks and the two WASM producers independently. Desktop consumes only
`release-wasm-bridge`; UI checks and the demo consume that same artifact plus
`release-browser-runtime`. UI checks also download the native test job's backend
and pass it to the Playwright wrapper, avoiding another native compilation.
