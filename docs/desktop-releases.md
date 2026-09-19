# Desktop builds and releases

The [Desktop artifacts workflow](../.github/workflows/desktop-artifacts.yml) builds these installers using the repository's Rust toolchain and Node 24:

| Platform | Native runner | Installer |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` | DMG |
| macOS Intel | `macos-15-intel` | DMG |
| Windows x64 | `windows-2022` | NSIS EXE |
| Linux x64 | `ubuntu-22.04` | Debian package and AppImage |

The web frontend and beat-detection model are prepared once and shared by the native packaging jobs. Native builds disable Cargo's default features to exclude Bevy dynamic linking; the Tauri configuration explicitly selects the desktop features.

Intel macOS uses OS-default thread scheduling because `gdt-cpus` supports only Apple Silicon on macOS. Backend priority and affinity tuning remain enabled on Apple Silicon, Linux, and Windows.

## Build channels

- Pushes to `main` build GitHub Actions artifacts, retained for 14 days. They do not create a GitHub Release and must not appear on `nightfall.live/downloads`.
- Pull requests changing the workflow, its helpers, or Tauri packaging configuration exercise the same builds without publishing.
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

4. Inspect the Desktop artifacts run. It collects five uniquely named installers and writes `SHA256SUMS`. Uploads go to a draft release, which becomes public only after every upload succeeds.

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

The Tauri action imports the signing identity, and Tauri signs and notarizes the app and staples its ticket. The workflow verifies the app signature, stapled ticket, and Gatekeeper assessment before staging installers. Publication requires every build to succeed.

Pull requests, including same-repository PRs, receive no signing credentials and use an ad-hoc macOS identity (`-`). Linux and Windows packaging receive no Apple credentials. Windows installers remain unsigned.

To validate credential setup, manually run **Desktop and browser artifacts** from a trusted branch containing the signing workflow. Manual runs produce artifacts without publishing a release. Download each macOS DMG through a browser and verify that the installed app opens without a security override. The normal confirmation for an Internet download may still appear.

See the official [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for certificate export and credential setup. Keep credentials in GitHub Actions secrets, never in repository files.

## Local workflow checks

```sh
node --test scripts/desktop-artifacts.node.test.mjs
node scripts/desktop-artifacts.mjs prepare
```

The second command reads the actual Tauri and Cargo versions. Outside a version-tag push it reports `publish: false`. The CI-specific Tauri configuration expects `webui/dist` and model resources to have already been prepared; ordinary local Tauri commands retain the normal frontend build hook.
