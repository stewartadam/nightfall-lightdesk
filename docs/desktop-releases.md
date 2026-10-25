# Desktop builds and releases

The [CI workflow](../.github/workflows/ci.yml) calls the [Desktop artifacts workflow](../.github/workflows/desktop-artifacts.yml) to build these installers using the repository's Rust toolchain and Node 24:

| Platform | Native runner | Installer |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` | DMG |
| Windows x64 | `windows-2022` | NSIS EXE |
| Linux x64 | `ubuntu-22.04` | Debian package and AppImage |

The web frontend is prepared once and shared by the native packaging jobs. It consumes the same release WASM bridge artifact as UI tests; the embedded demo engine is built separately and is excluded from desktop bundles and their WASM notices. The beat-detection model is an optional, checksum-verified download offered on first use or through Settings; it is stored in the application data directory and is not included in installers. Saved beat grids and playback do not require it. Native builds use the `app-tauri` crate's default features.

Generated macOS installers target Apple Silicon only.

## Build channels

- Pushes to `main` build unsigned/ad-hoc GitHub Actions artifacts, retained for 14 days. They do not create a GitHub Release and must not appear on `nightfall.live/downloads`.
- Pull requests changing distribution workflows, their build inputs, runtime entry points, or Tauri packaging configuration exercise the same builds without publishing.
- Manual workflow runs produce CI artifacts only, including when run against a tag.
- A pushed `v<version>` tag signs/notarizes macOS on an isolated runner and creates a draft GitHub Release after every platform build and signing succeeds. A maintainer reviews and publishes the draft. The tag must exactly match the Tauri application version and Cargo workspace version. Versions such as `v0.2.0-beta.1` produce prereleases.

This repository supplies the tagged GitHub Release assets. The `nightfall.live/downloads` site should list published releases and their installers, excluding Actions artifacts and drafts.

## Cutting a release

1. Set the same version in `Cargo.toml` under `[workspace.package]` and in `desktop/app-tauri/tauri.conf.json`. Update `Cargo.lock` through Cargo and merge the version change after validation. Include a `Notes:` declaration on every PR, including version-only PRs; see [PR release notes](contributing/release-notes.md). Preserve commit ancestry when promoting `develop` to `main` so the release includes the original PR notes.
2. Verify the `main` artifacts on each target operating system, including startup, showfile save/open, and beat detection from the installed application.
3. Create and push the matching version tag, for example:

   ```sh
   git tag -a v0.1.0 -m "Nightfall 0.1.0"
   git push origin v0.1.0
   ```

4. Inspect the desktop jobs in the CI run. Preparation collects PR release notes since the closest ancestral published release and saves a Markdown preview and JSON report. It collects four uniquely named installers and the macOS update archive, and writes `SHA256SUMS`. Uploads go to a draft release with those notes and installation information. The workflow never publishes it; the publish job's summary links to the draft.
5. Review the draft under the repository's Releases. Edit its notes in the GitHub UI or with `gh release edit v0.1.0 --notes-file notes.md`, then publish it with **Publish release** or `gh release edit v0.1.0 --draft=false`. Publishing also offers the release to installed apps; see [Automatic updates](#automatic-updates).
6. Bump the version listed on the nightfall.live Downloads page.

To write the notes by hand from the start, create the draft before pushing the tag (`gh release create v0.1.0 --draft --title "Nightfall 0.1.0" --notes-file notes.md`, adding `--prerelease` for prerelease versions); the workflow reuses an existing draft and keeps its body. Rerunning the workflow resumes uploads into the same draft without changing its notes. Rerunning an already-public release fails instead of replacing its files. Keep release tags and published artifacts immutable; use a new version for corrections.

Installer names include the version and architecture target, for example `nightfall-v0.1.0-aarch64-apple-darwin.dmg`. Download `SHA256SUMS` with the installers to verify their hashes (`sha256sum -c SHA256SUMS` on Linux, or `shasum -a 256 -c SHA256SUMS` on macOS).

## Signing status

Only version-tag pushes use a Developer ID Application certificate and Apple notarization. The isolated Apple Silicon signing job requires all six repository secrets below; missing credentials fail the release instead of falling back to ad-hoc signing.

| Repository secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export containing the certificate and its private key (not a `.cer` file) |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12` export |
| `APPLE_SIGNING_IDENTITY` | Full identity, such as `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Tauri builds an ad-hoc signed app without credentials. A fresh runner downloads only the app artifact and uses system tools to sign, notarize, staple, and verify it before creating the release DMG. The DMG is also signed, notarized, and stapled. No project scripts, dependency installation, or compilation run on this runner. The draft release is created on a third runner after every build and signing succeeds. See [CI trust boundaries](ci-security.md) for the design philosophy, artifact validation, and maintenance rules.

Pull requests (including same-repository PRs), branch pushes, and manual runs receive no signing credentials and use an ad-hoc macOS identity (`-`). Linux and Windows packaging receive no Apple credentials. Windows installers remain unsigned.

Manual runs validate unsigned packaging only. Validate real credentials on an intentional prerelease tag after reviewing and testing the commit. Download the published macOS DMG through a browser and verify that the installed app opens without a security override. The normal confirmation for an Internet download may still appear.

See the official [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for certificate export and credential setup. Keep credentials in GitHub Actions secrets, never in repository files.

## Automatic updates

Published releases update themselves with Tauri's [updater plugin](https://v2.tauri.app/plugin/updater/). Every other build (pull request and fork builds) has no updater key compiled in, so it can't verify a download: it still checks, but sends the operator to nightfall.live/downloads for a newer version instead of downloading it. `tauri dev` only checks when asked from **About**. The app checks at most once a day: a check that finds nothing newer is remembered in `updates.json`, and the next one waits a day from then, even across restarts (and at least 15 seconds after startup). It never installs while running. **When an update is available** in **About** picks what happens next: **Notify me** waits for the operator to choose **Download**; **Download, install when I choose** (the default) downloads and verifies it in the background, then installs only when the operator picks **Restart to update** from the notice or **About**; **Download and install on quit** also installs it on the next quit, without restarting the app. **Allow update checks** in **Settings > Privacy** turns checking off entirely. The backend saves work as on any other quit before the update installs. A downloaded update is saved in the `updates` folder of the data directory, so a restart doesn't download it again, and it stays ready until a strictly newer version has finished downloading. Before installing, the app records the version in `updates.json`; the next launch then says **Nightfall updated** and deletes the package, or reports that the install failed and keeps the previous version. A version that failed to install never installs on quit or downloads again on its own: the operator retries it with **Try Again** in **About**, and a newer release replaces it. Each launch also deletes installer folders that earlier Windows updates left in the temporary directory. `scripts/test-desktop-updater.sh` tries all of this against a local stand-in update service.

Debug builds (`tauri dev` and `tauri build --debug`) can also show any update state without an update service. In the web inspector console, `nightfallUpdates.presets()` lists ready-made states such as `ready`, `download-failed` or `check-only-available`, and `nightfallUpdates.show("ready")` shows one. `nightfallUpdates.set({ canInstall: false })` changes single fields, named as in `DesktopUpdateState`, and `nightfallUpdates.reset()` shows the real status again. A shown state is never saved, and Download or Restart to update do nothing for a version the app never found. Changing `canInstall` does affect real checks, so a check from **About** afterwards behaves like a build that can or can't install updates itself. A preset that is checking, downloading or ready holds back real checks until `reset()`, just as the real phase would. Release builds don't include these commands.

The app polls `https://nightfall.live/api/v1/updates/alpha/<platform>/<architecture>/<install type>/<version>`. That URL and the signing key are compiled into every installed app, so changing either one needs a bridge release first: a release that still answers at the old URL, or is signed with the old key, and carries the new one. nightfall.live redirects every such request to `latest.json` on this repository's `updater` release, so a dynamic update server can later take over the same URL without breaking installed apps.

On a version tag, the macOS signing job also archives the stapled app as `…-aarch64-apple-darwin.app.tar.gz`, which installed Mac apps unpack in place of their bundle, and the draft release carries it next to the installers. Publishing that release runs the **Desktop updates** workflow (`desktop-updates.yml`). Its signing job downloads the four update packages (the macOS archive, the Windows installer, the Debian package, and the AppImage) from the release and signs each with a pinned, checksum-verified [minisign](https://jedisct1.github.io/minisign/) release. Each signature binds the release version, and the app refuses a package whose signed version differs from the manifest. A second job, which never sees the key, replaces `latest.json` on the `updater` release, creating that release the first time. Publishing a release is therefore what offers it to installed apps, and drafts are never offered.

| Setting | Kind | Value |
| --- | --- | --- |
| `TAURI_SIGNING_PUBLIC_KEY` | Repository variable | Public key from `pnpm tauri signer generate`, compiled into published releases |
| `TAURI_SIGNING_PRIVATE_KEY` | Repository secret | The matching private key, exactly as `tauri signer generate` writes it |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Repository secret | The password chosen for that key (required) |

Keep a backup of the private key and its password outside GitHub. Installed apps accept only packages signed with this key, so losing it means they can no longer update.

## Website release

When the Desktop updates workflow succeeds for a published release, the **Website release** workflow (`website-release.yml`) sends the tag and commit to nightfall.live. nightfall.live then opens one pull request that moves its downloads page, user guide and browser demo to that release. The demo comes from the tested browser-demo artifact that CI built when the tagged commit landed on `main`, so a release published more than seven days after that merge needs a fresh one: re-run all jobs of that `main` push's CI run, then re-run nightfall.live's Release workflow for the tag. nightfall.live only accepts the demo from a successful `main` push, since manual preview runs upload untested builds under the same name.

The workflow authenticates as a GitHub App installed on this repository and nightfall.live, with Contents (read and write), Pull requests (read and write) and Actions (read) repository permissions. Both repositories hold the same two settings:

| Setting | Kind | Value |
| --- | --- | --- |
| `RELEASE_APP_CLIENT_ID` | Repository variable | The App's client ID |
| `RELEASE_APP_PRIVATE_KEY` | Repository secret | A private key generated for the App |

## Local workflow checks

```sh
node --test scripts/desktop-artifacts.node.test.mjs
node --test scripts/ci-security.node.test.mjs
node scripts/desktop-artifacts.mjs prepare
```

The second command reads the actual Tauri and Cargo versions. Outside a version-tag push it reports `publish: false`. The CI-specific Tauri configuration expects `webui/dist` to have already been prepared; ordinary local Tauri commands retain the normal frontend build hook.

## Sample audio resources

The Lo-fi and Rap MP3s are Git LFS assets packaged under `sample-audio` in Tauri's
resource directory, separate from the executable. The bundling hook rejects
missing files, empty files, and unresolved LFS pointers. New sample shows copy
these files into their own timeline-audio folders; existing shows retain their
own copies when application resources change.

After an initial `pnpm tauri build`, audio-only changes can be repackaged with
`pnpm tauri bundle --bundles <formats>` (add `--target <triple>` or `--debug`
to match the original build). This runs the resource validation and bundler without
Cargo compilation. Normal `tauri build` may still rerun Tauri's resource staging
when resources change; use the bundle-only command for audio-only updates.
Signed desktop resources must be replaced through rebuilding/signing the bundle,
rather than editing an installed signed application in place.

For a standalone backend, run `pnpm run package:sample-audio <executable-directory>`
and distribute that executable together with the generated `sample-audio` folder.
These sidecar files can be replaced without compiling the backend. No audio
resources are needed to create empty shows or load existing self-contained shows.
