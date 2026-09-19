# Cached WASM assets

Run after checkout, Node/Rust setup and `npm ci`. The action builds or restores
both wasm-pack packages, including generated JavaScript, TypeScript declarations
and the final optimized WASM binaries. Development and release builds use separate
keys. The existing Cargo cache still accelerates cache misses.

Only exact matches are restored. Keys include the compiler identity, runner OS
and architecture, profile, Cargo manifests/lockfile, whole crate trees, Cargo
configuration, shared configuration and fixtures, build scripts, npm manifests
and lockfile, license, workflows and this action. This deliberately favors extra
misses over stale binaries: even unrelated native crate changes invalidate the
cache. Add any future build inputs outside these paths to the key. Build settings
must remain in the hashed repository configuration/workflows.

The action checks both packages' entry points and saves successful builds before
later frontend builds or tests run. Per-commit release artifacts are still
uploaded normally, including on cache hits; only the generated WASM is reused,
so frontend build metadata and distribution notices remain fresh.
