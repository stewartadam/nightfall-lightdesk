# Pull request release notes

Part of the [contributing guide](../../CONTRIBUTING.md).

Every PR declares its release-note intent in its description. Notes stay on GitHub;
there are no per-change fragments in the development branch. Review the wording
alongside the code: describe the effect on users, conditions under which a fix
matters, and any action required when upgrading.

Use one sentence:

```markdown
Notes: Fixed an issue where stopping a cue left fixtures at their previous intensity.
```

Or one complete entry per bullet:

```markdown
Notes:
- Added controls for adjusting parameter lanes in the timeline.
- Fixed playback jumping when changing the selected cue.
```

For an intentional omission, supply a specific reason:

```markdown
Notes: none (test coverage only; no user-visible behavior changed)
```

Bare `none`, empty declarations, duplicate declarations, and placeholders such as
`TODO` fail. Comments and fenced code examples do not count. Put a blank line or
a Markdown heading after the entry, before the next PR section. A skip label is
not necessary and does not bypass the check. Reviewers decide whether prose is
useful and whether the omission is justified; the check validates structure.

## Required check and rollout

The **Release notes** job in `release-notes.yml` validates the current description
on PR creation, reopening, new commits, description edits, and readiness changes.
A read-only acquisition job snapshots the live description and the parser from
the PR merge commit. The **Release notes** job executes that parser on a fresh
runner with `permissions: {}` and writes a preview to the Actions job summary.
This also validates PRs that introduce or modify the parser. The `pull_request`
workflow receives no repository secrets and does not persist checkout credentials.
Changes to the parser and workflow need review, like changes to other CI checks.

After this workflow and its script reach both PR base branches (`develop` and
`main`), add **Release notes** (GitHub Actions) to the **Protected branches**
ruleset's required status checks, retaining the existing checks. Do not require it
before rollout to those branches: unrelated PRs opened against an older base may
not contain the workflow or validator. The introducing PR can validate itself
using its merge commit. Confirm a new PR fails with an empty entry,
passes after adding prose, fails if the prose is removed, and passes with an
explicit omission reason. This repository change alone does not update GitHub's
ruleset settings.

Existing unreleased PRs need their descriptions updated before the next tag if
they lack valid notes. There is no automatic exemption for old or bot-authored
PRs. Deleted or invalid notes on an included merged PR stop release preparation
with the PR number, so repair that description and rerun preparation.

## Preparing a release

The tagged desktop workflow collects notes before packaging. Its baseline is the
closest published release reachable from the target commit, including alpha/beta
releases. Draft releases, the target commit itself, and releases on unrelated
branches are excluded. Proximity is measured by commits in the range, not release
date or version ordering. Thus each prerelease describes changes since the last
published prerelease, rather than repeating the whole series.

The collector walks all parents between that baseline and the target. It looks up
associated merged PRs and includes only PRs whose merge commit is in that range,
deduplicated by PR number. `feat` titles group notes under Improvements, `fix`
titles under Fixes, and other titles under Changes. The actual entry text comes
from `Notes:`, not the title. Explicit omissions stay in the JSON report but do
not appear in the published notes. Commits without a matching PR appear with
their commit subjects under Additional commits, making direct pushes visible;
prefer PRs for user-facing changes and version bumps.

Preserve commit ancestry when promoting `develop` to `main`: merge the branch
rather than squash or rebase it. Feature PRs into `develop` can still be squashed.
A promotion PR should declare `Notes: none (promotes changes already described by
their PRs)`. The collector rejects a recognized squashed/rebased `develop` → `main`
PR because its original feature PRs cannot reliably be assigned to that release.
Direct promotion merges also preserve ancestry; their merge commit appears under
Additional commits. Branch protection currently requires linear history, so
promotion merges need the same maintainer bypass used by the existing release
process; this change does not alter that policy.

Preview locally with Node 24, authenticated `gh`, and all release tags fetched:

```sh
git fetch origin --tags
node scripts/release-notes.mjs generate --repo stewartadam/nightfall-lightdesk \
  --to v0.2.0 --output /tmp/nightfall-release-notes.md
```

Use `--from <ancestor-ref>` to select an explicit comparison baseline, including
when previewing an untagged branch or preparing a first release. `--to` may also
be a commit or branch for local previews. Generation is read-only on GitHub and
writes Markdown plus `<output>.json` containing commit IDs, included notes,
omission reasons, and unmatched commits. Avoid putting generated files in Git.

The workflow saves both files as `release-notes-<commit>` for 90 days. The existing
publisher uses this Markdown and the standard installation information when
creating its draft release, then publishes after every installer upload succeeds.
It does not reread PR descriptions during publishing. A full rerun including the
metadata acquisition job does reread them; PR descriptions are mutable until the release is cut. An
existing draft's manually edited body is preserved on publication retry. Published
releases remain immutable under the existing workflow.

CI separates API collection from script execution: source acquisition snapshots
published releases, permissionless preparation plans commit IDs, a read-only job
fetches their PR associations, and a permissionless job renders the final notes.
The script's `--metadata DIR` mode reads those snapshots without invoking `gh`;
missing snapshots fail rather than falling back to authentication. The `plan`
command emits the same ancestry range used by `generate`. Local previews can
still query GitHub directly when `--metadata` is omitted. See
[CI trust boundaries](../ci-security.md) for the security model.

## Validation

```sh
node --test scripts/release-notes.node.test.mjs scripts/desktop-artifacts.node.test.mjs
npx prek run actionlint --all-files
```

Tests cover prose and omission parsing, actual Git promotion ancestry, duplicate
associations, unrelated releases, prereleases, direct commits, and failure paths.
No external bot service, Python runtime, or npm package is required.
