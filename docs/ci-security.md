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

- **Acquire:** `ci-precommit.yml`'s `scope` job checks out the event's exact SHA,
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
- **Publish:** another fresh runner downloads the installers, notices, and release
  notes as data. It requires exactly four installers and one combined notices file,
  rejects empty files and links, computes checksums, and uploads a draft release
  before publishing it. It runs no downloaded code or project scripts. Only this
  job uses a write-capable GitHub token; the reusable-workflow caller supplies
  that permission ceiling, while the signer retains `permissions: {}`.

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
and `npx prek run actionlint --all-files`. The security tests exercise the actual
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
