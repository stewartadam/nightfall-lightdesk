# Desktop builds and releases

The [CI workflow](../.github/workflows/ci-precommit.yml) calls the [Desktop artifacts workflow](../.github/workflows/desktop-artifacts.yml) to build these installers using the repository's Rust toolchain and Node 24:

| Platform | Native runner | Installer |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` | DMG |
| Windows x64 | `windows-2022` | NSIS EXE |
| Linux x64 | `ubuntu-22.04` | Debian package and AppImage |

The web frontend is prepared once and shared by the native packaging jobs. It consumes the same release WASM bridge artifact as UI tests; the embedded demo engine is built separately and is excluded from desktop bundles and their WASM notices. The beat-detection model is an optional, checksum-verified download offered on first use or through Settings; it is stored in the application data directory and is not included in installers. Saved beat grids and playback do not require it. Native builds disable Cargo's default features to exclude Bevy dynamic linking; the Tauri configuration explicitly selects the desktop features.

Generated macOS installers target Apple Silicon only.

## Build channels

- Pushes to `main` build GitHub Actions artifacts, retained for 14 days. They do not create a GitHub Release and must not appear on `nightfall.live/downloads`.
- Pull requests changing distribution workflows, their build inputs, runtime entry points, or Tauri packaging configuration exercise the same builds without publishing.
- Manual workflow runs produce CI artifacts only, including when run against a tag.
- A pushed `v<version>` tag publishes a GitHub Release after every platform build succeeds. The tag must exactly match the Tauri application version and Cargo workspace version. Versions such as `v0.2.0-beta.1` produce prereleases.

This repository supplies the tagged GitHub Release assets. The `nightfall.live/downloads` site should list published releases and their installers, excluding Actions artifacts and drafts.

## Cutting a release

1. Set the same version in `Cargo.toml` under `[workspace.package]` and in `crates/app/tauri.conf.json`. Update `Cargo.lock` through Cargo and merge the version change after validation.
2. Verify the `main` artifacts on each target operating system, including startup, showfile save/open, and beat detection from the installed application.
3. Create and push the matching version tag, for example:

   ```sh
   git tag -a v0.1.0 -m "Nightfall 0.1.0"
   git push origin v0.1.0
   ```

4. Inspect the desktop jobs in the CI run. It collects four uniquely named installers and writes `SHA256SUMS`. Uploads go to a draft release, which becomes public only after every upload succeeds.

A failed upload leaves a draft that the same workflow can resume. Rerunning an already-public release fails instead of replacing its files. Keep release tags and published artifacts immutable; use a new version for corrections.

Installer names include the version and architecture target, for example `nightfall-v0.1.0-aarch64-apple-darwin.dmg`. Download `SHA256SUMS` with the installers to verify their hashes (`sha256sum -c SHA256SUMS` on Linux, or `shasum -a 256 -c SHA256SUMS` on macOS).

## Signing status

macOS builds on pushes to `main`, version-tag pushes, and manual workflow runs use a Developer ID Application certificate and Apple notarization. Both Apple Silicon and Intel jobs require all six repository secrets below; missing credentials fail the build instead of falling back to ad-hoc signing.

| Repository secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export containing the certificate and its private key (not a `.cer` file) |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12` export |
| `APPLE_SIGNING_IDENTITY` | Full identity, such as `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Tauri imports the signing identity, signs and notarizes the app, and staples its ticket. Signed builds retain both the app bundle and DMG so the app can be verified; only the DMG is staged as an installer. The workflow verifies the app signature, stapled ticket, and Gatekeeper assessment before staging installers. Publication requires every build to succeed.

Pull requests, including same-repository PRs, receive no signing credentials and use an ad-hoc macOS identity (`-`). Linux and Windows packaging receive no Apple credentials. Windows installers remain unsigned.

To validate credential setup, manually run **CI (Prek Parity + WebUI Tests)** from a trusted branch containing the signing workflow. Manual runs produce artifacts without publishing a release. Download each macOS DMG through a browser and verify that the installed app opens without a security override. The normal confirmation for an Internet download may still appear.

See the official [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for certificate export and credential setup. Keep credentials in GitHub Actions secrets, never in repository files.

## Local workflow checks

```sh
node --test scripts/desktop-artifacts.node.test.mjs
node scripts/desktop-artifacts.mjs prepare
```

The second command reads the actual Tauri and Cargo versions. Outside a version-tag push it reports `publish: false`. The CI-specific Tauri configuration expects `webui/dist` to have already been prepared; ordinary local Tauri commands retain the normal frontend build hook.

## Sample audio resources

The Lo-fi and Rap MP3s are Git LFS assets packaged under `sample-audio` in Tauri's
resource directory, separate from the executable. The bundling hook rejects
missing files, empty files, and unresolved LFS pointers. New sample shows copy
these files into their own timeline-audio folders; existing shows retain their
own copies when application resources change.

After an initial `npm run tauri-build`, audio-only changes can be repackaged with
`npm run tauri-bundle -- --bundles <formats>` (add `--target <triple>` or `--debug`
to match the original build). This runs the resource validation and bundler without
Cargo compilation. Normal `tauri build` may still rerun Tauri's resource staging
when resources change; use the bundle-only command for audio-only updates.
Signed desktop resources must be replaced through rebuilding/signing the bundle,
rather than editing an installed signed application in place.

For a standalone backend, run `npm run package:sample-audio -- <executable-directory>`
and distribute that executable together with the generated `sample-audio` folder.
These sidecar files can be replaced without compiling the backend. No audio
resources are needed to create empty shows or load existing self-contained shows.
