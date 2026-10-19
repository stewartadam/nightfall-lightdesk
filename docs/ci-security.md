# CI trust boundaries

Our rule is: **a job may execute repository/dependency code, or hold release
authority, but never both.** Treat every compiler invocation, Cargo build script
or procedural macro, npm lifecycle hook, test, and installed build tool as
arbitrary code execution. A compromised dependency must not inherit our Apple
identity or permission to publish a release.

This follows the [separate execution from secrets philosophy](https://www.reddit.com/r/rust/comments/1wmmp7t/github_actions_leaking_secrets_when_miri_output/pb9bufi/).
Secret masking is a logging convenience, not the security boundary. Moving a
secret to a later step on the same runner is insufficient: earlier code can
modify tools and leave background processes behind.

## Job boundaries

```text
Source acquisition (contents: read; no repository code execution)
    │ exact event revision, resolved LFS files, credential-free Git history
    ▼
Build / test / package (permissions: {}; no release secrets)
    │ artifacts from this workflow run
    ▼
macOS signing (fresh runner; permissions: {}; Apple credentials)
    │ signed, notarized DMG
    ▼
Publication (fresh runner; contents: write; no Apple credentials)
```

- **Acquire:** `ci.yml`'s `scope` job checks out the event's exact SHA,
  including the PR merge revision and two commits of history for change
  selection. Tag runs acquire full history/tags for release-note ancestry.
  Checkout has `persist-credentials: false`. The source tar preserves
  executable bits, hidden files, Git tracking/history needed by prek, and resolved
  LFS media. It excludes Git hooks and redundant LFS object storage. This runner
  refuses to archive persisted Git credential or HTTP authorization settings.
  It never installs project dependencies, runs project scripts, or restores caches.
  On release tags it also snapshots the published-release API as plain data.
- **Execute:** native checks, WASM, UI tests, browser-demo packaging, and desktop
  packaging download that source artifact. All workflows default to
  `permissions: {}`. Build jobs receive no explicit secrets and never checkout
  with an authenticated token. Reusable build workflows must be called after
  source acquisition in the same run. Build caches remain inside this boundary.
  Windows restores symlinks as regular files containing their target paths,
  matching Git's `core.symlinks=false` checkout behavior without requiring
  symlink privileges or relying on archive entry order.
- **Release metadata:** permissionless preparation plans which commit IDs need PR
  associations. A separate read-only job accepts only hexadecimal commit IDs and
  fetches those API responses with inline `gh` commands; it never downloads or
  executes repository scripts. Another permissionless job renders changelog prose
  from the saved snapshots. PR-description validation uses the same pattern:
  acquire the current description and merge-commit validator as data, then execute
  that validator on a fresh permissionless runner. Offline scripts fail on missing
  snapshots rather than falling back to a token. These metadata jobs are the only
  additional read-permission exceptions; reusable-workflow caller permissions are
  ceilings, not permissions granted to the build/render jobs.
- **Sign:** `release.yml` uses a new macOS runner and only a tar of the built app.
  It checks the tag event, app identifier, executable name, and version; rejects
  traversal, duplicate paths, symlinks, hardlinks, and special files; then copies
  regular file bytes into a fresh directory. It uses system signing/notarization
  tools without installing dependencies, executing the app, or restoring source
  or build caches. It signs Mach-O files before the outer app, enables hardened
  runtime and timestamps, notarizes and staples the app, creates a DMG, and signs,
  notarizes, and staples that DMG. A temporary keychain is removed on exit.
  The current app has no bundled frameworks or nested application bundles;
  adding those requires reviewing extraction and inside-out signing support.
- **Update signing:** publishing a release runs `desktop-updates.yml`. A fresh
  Linux runner downloads the four update packages (the signed macOS app archive,
  Windows installer, Debian package, and AppImage) from that release as data and
  signs each one with the updater key. This key is release authority: every
  installed app accepts what it signs. The job holds only
  `TAURI_SIGNING_PRIVATE_KEY` and its password, and a read-only token. It runs
  system tools and one installed tool, an exact minisign release whose SHA-256 is
  pinned in the workflow and checked before use. It checks each signature against
  the `TAURI_SIGNING_PUBLIC_KEY` variable, removes the decoded key on exit, and
  writes `latest.json`. A second runner, which never sees the key, checks that the
  manifest names the published version and replaces it on the `updater` release.
- **Publish:** another fresh runner downloads the installers, notices, and release
  notes as data. It requires exactly the four installers, the macOS update archive, and one combined notices file,
  rejects empty files and links, computes checksums, and uploads them to a draft
  release, which a maintainer reviews and publishes. It runs no downloaded code or project scripts. In the tag workflow, only this
  job uses a write-capable GitHub token; the reusable-workflow caller supplies
  that permission ceiling, while the signer retains `permissions: {}`.
- **Preview:** for ready same-repository PRs, and for drafts through `/republish`, a fresh runner downloads this run's
  browser-demo artifact as data and uploads it as a private Cloudflare Workers
  Preview, then comments the link on the PR. It is the one credentialed job that
  runs installed tooling: the pinned `cloudflare/wrangler-action` installs an exact
  Wrangler version from npm. That is acceptable because the job holds no release
  authority, only a token limited to Workers Scripts edits and a
  `pull-requests: write` GitHub token, and never acquires source or build caches.
  Fork PRs never select a preview, so they never reach this credential.
- **PR commands:** `pr-commands.yml` runs on PR comments from the default
  branch's copy of the workflow, never the PR's, and only for commenters with
  write or admin access (checked by the pinned `github/command` action). It never
  acquires source or runs project code. `/recheck-cla` only calls the public
  cla-assistant.io check URL and reads commit statuses. `/republish` holds
  `actions: write` solely to rerun jobs of the PR's existing CI run, so the rerun
  keeps that run's own permissions and artifacts, or, for a draft PR, to dispatch
  `ci.yml` on the PR's own branch with the preview input. That manual run follows
  the same boundaries as the PR's CI run, and `/republish` refuses fork and
  Dependabot PRs, so it never hands the preview credential to code CI would not.
- **Debug symbols:** on version tags, a fresh runner downloads this run's debug
  symbol artifacts as data and uploads them to the error service so crash stack
  traces resolve to functions and lines. It holds only `GLITCHTIP_AUTH_TOKEN`,
  which should be limited to uploading project files, and no GitHub permissions.
  It runs one installed tool, an exact `glitchtip-cli` release whose SHA-256 is
  pinned in the workflow and checked before use; it never acquires source or
  build caches.

Only version-tag **pushes** enter signing/publication. PRs (including same-repo
PRs), branch pushes, and manual runs never do. The build validates that the tag
matches Cargo/Tauri versions; privileged jobs additionally check their own event
and derive release names from the tag, not a build-generated command or script.
The six Apple secrets are passed explicitly to the release workflow and exposed
only to its signing step. There is no `secrets: inherit`.

## Artifact and cache rules

Artifact upload and same-run download use Actions' runtime artifact service;
they do not require granting build jobs repository write permissions. Keep these
transfers in the same workflow run: do not introduce a privileged `workflow_run`
consumer that accepts arbitrary PR artifacts, or download a “latest” artifact
from another run. SHA-labelled names aid identification; they are not proof that
the artifact's bytes are trustworthy.

Never restore Cargo, npm, tool, or generated-WASM caches in signing/publication.
Cache hashes describe inputs, not provenance. A compromised build may poison
outputs or caches it can write, but those must not become executable tools on a
credential-bearing runner. Cached binaries are only executed by permissionless
build/test jobs.

Every external action is pinned to a full commit SHA. Dependabot proposes Actions
updates weekly; review those changes, especially checkout and artifact handling
at the privileged boundaries. Review changes to inline release scripts as
security-sensitive code. Do not replace them with scripts supplied by a build
artifact or an npm/Cargo installation.

## Limits and repository administration

`permissions: {}` restricts `GITHUB_TOKEN`; it does not remove network access,
artifact/cache runtime credentials, or explicitly supplied secrets. This design
contains credential theft and repository mutation after a build compromise. It
does **not** prove a produced installer is benign: compromised code can still
produce a malicious artifact that passes structural checks and is signed.
Checksums detect changed bytes, not malicious intent. System parsers and the
pinned actions used by privileged jobs remain trusted dependencies.

Protect release tags and changes to workflows/release policy through repository
rules and review. Anyone allowed to push arbitrary release workflow code can
change these boundaries. GitHub environment approval policies can add a human
release gate, but no environment configuration is assumed by these workflows.
Existing repository Apple secrets remain supported. Tests should pass on the
reviewed commit before tagging; the tag pipeline retains the existing policy of
building distributions rather than repeating the full native/UI test suite.

## Validation

Run `node --test scripts/ci-security.node.test.mjs scripts/desktop-artifacts.node.test.mjs`
and `pnpm exec prek run actionlint --all-files`. The security tests exercise the actual
inline archive and inventory validators with hostile fixtures, enforce token
permissions/action pins, and check that privileged runners cannot acquire source
or build dependencies. They require Python 3 and Bash alongside Node.

Hosted validation is still required for GitHub runtime artifact authentication,
cross-platform source extraction, and real Apple credentials/notarization. A
normal PR/main/manual run should produce ad-hoc macOS artifacts without any
signing job. On the next intentional prerelease tag, check the app and DMG
signatures/tickets, download the published DMG through a browser, and verify the
installed app launches without a security override. No local test simulates
Apple's notarization service or claims to establish artifact trust.
