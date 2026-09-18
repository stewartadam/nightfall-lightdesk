# Distribution notices

Nightfall's source checkout references dependencies; it does not redistribute
their compiled code. The notice inventory describes the software shipped in a
build. Generated inventories stay out of Git. Reviewed license supplements and
the generation policy are checked in under `config/notices/` and `about.toml`.

Install the pinned Rust license collector before building web or desktop assets:

```sh
cargo install cargo-about --locked --version 0.8.4
```

`npm run build` and `npm run build:browser-demo` generate these files in
`webui/dist/notices/`:

- `THIRD-PARTY-NOTICES.json`: the searchable About dialog's inventory.
- `THIRD-PARTY-NOTICES.txt`: the same complete notices, readable offline.
- `NIGHTFALL-LICENSE.txt`: Nightfall's own license.
- `frontend.json`: Vite's bundled-package inventory, including worker packages.

The frontend inventory follows bundled modules, not the full npm dependency
tree. Explicit additions cover CSS libraries and Vite's injected preload code.
Both shipped WASM modules contribute their target-specific Rust dependencies.
Cargo collection retains build dependencies conservatively because build
scripts and macros can embed third-party code; dev dependencies are excluded.
Original LICENSE, COPYING, NOTICE, COPYRIGHT and AUTHORS files are retained,
including nested files for vendored native code. License text collection does
not rely on Cargo's synthesized copyright placeholders.

For local Tauri builds, the frontend build uses `TAURI_ENV_TARGET_TRIPLE` to add
the native application graph with the features in `tauri.conf.json`. CI builds
the shared web assets once, then runs this on each packaging runner:

```sh
npm run notices:desktop -- aarch64-apple-darwin
```

Use the actual installer target. The Tauri resource map includes the notices
directory, and the same files are embedded with the frontend. Desktop artifact
staging checks the target and publishes an additional notice text file next to
each platform's installers. Browser-demo packaging checks its web inventory and
includes the notices in its integrity manifest. Do not redistribute raw binaries
or extracted WASM files without the applicable notices.

The Vite development server displays an explicitly labelled preview of installed
production dependencies, including build tools. Its preview is not the release
inventory and does not require Cargo or a completed build.

## Updating dependencies

Release generation uses cargo-about's selected license IDs and full texts, including
its harvested upstream license files. Rebuild after dependency changes. When a
crate omits its license file, prefer a native `[crate.clarify]` entry with
`[[crate.clarify.git]]` in `about.toml`: record the SPDX expression, repository-relative
license path and SHA-256 checksum. Cargo-about retrieves the file from the commit
in the published crate's `.cargo_vcs_info.json`; clean builds need network access
for this harvesting.

The adapter also preserves ancillary NOTICE, COPYRIGHT and AUTHORS files and
nested licenses for vendored code. If cargo-about emits a generic copyright
placeholder, it falls back to the crate's original packaged license text. Missing
attribution without an original or reviewed fallback fails packaging.

Checked-in Rust supplements are limited to gaps cargo-about cannot currently
resolve: missing repository metadata (some Wasmtime and partially crates), the
`.git` repository URL handling for dasp_sample, and enum-flags' absent upstream
license file. Their exact versions, source URLs and normalized SHA-256 hashes
remain in `config/notices/supplements.json`. Prefer cargo-about clarifications
when upstream metadata or collector support improves.

Preline is explicitly treated as MIT **and** its custom Fair Use License, not
as an SPDX choice of licenses. Both full texts, its copyright, and a clickable
repository attribution are included. `preline.json` pins the reviewed version
and license hash, so updates require review of its noncompetition and other
custom restrictions. Nightfall is a lighting controller, not a UI framework.

The original Phosphor artwork notice accompanies the SolidJS wrapper's notice.
The Beat This notice is included verbatim; its model provenance and treatment
are unchanged. The enum-flags package declares MIT but publishes no separate
license or copyright notice: its supplement records the manifest author and
the standard MIT terms without inventing a copyright statement.

## Source availability and installer boundaries

Each Rust registry dependency includes a link to its exact published source archive,
including MPL components such as Symphonia. If covered dependency files are
modified or patched, supply that modified source and update the source location;
a registry archive would no longer describe the distributed component.

The collectors inventory npm/Cargo components and their vendored legal files.
They do not inspect libraries added later by installer tooling, notably Linux
AppImage system libraries and its runtime. An installer-level audit must check
those additional files, their notices and any corresponding-source obligations
before release. System libraries supplied by the user's OS are not themselves
redistributed by Nightfall. This distinction must be checked against the actual
installer, not inferred from a Cargo `*-sys` crate's license.
