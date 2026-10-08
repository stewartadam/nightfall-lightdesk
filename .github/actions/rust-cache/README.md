# Rust cache

Every CI job that caches Cargo state uses this action instead of calling
`Swatinem/rust-cache` directly. Run it after source extraction and after the step
that installs the pinned toolchain (`rustup show` or `rustup target add`).

## Pinned toolchain key

`rust-cache` hashes every installed toolchain into its key, not only the active
one. Hosted runner images preinstall a stable Rust, and GitHub rolls new images
out gradually, so two jobs using the same pinned nightly could land on images with
different stable versions and miss each other's caches. The action therefore
uninstalls every toolchain except the active one from `rust-toolchain.toml` first.
The key then follows the pinned compiler's `rustc -vV` output (release and commit
hash), so it stays correct even if the pin ever becomes a floating channel.

## Cache report

Each job summary gets a "Rust cache" section:

- **Restore** is `exact hit`, `partial hit (older cache)` when a fallback key
  restored artifacts, or `miss`. Tool-only caches (`cache-targets: false`) report
  only whether the key matched exactly.
- For caches with compiled artifacts, a table counts Cargo units reused from the
  cache and units rebuilt by the job, split into dependencies and workspace
  crates, and lists rebuilt dependencies.

A unit counts as rebuilt when Cargo wrote its fingerprint after the cache was
restored, so the report covers every Cargo invocation in the job, including
builds driven by `tauri-action`. It runs as a post step before `rust-cache`
prunes the target directory, and never fails the job. The logic and its tests
live in `scripts/cargo-cache-report.mjs`.
