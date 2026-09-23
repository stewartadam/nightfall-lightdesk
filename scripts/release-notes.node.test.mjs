// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectReleaseNotes,
  parseReleaseNote,
  previousRelease,
  renderReleaseNotes,
} from "./release-notes.mjs";

/** Notes remain separate from the implementation summary and support multiple user-facing entries. */
test("parses prose, bullets, comments and explicit omissions", () => {
  assert.deepEqual(
    parseReleaseNote(
      "## Summary\nInternal details.\n\n## Release notes\nNotes: Fixed cue playback.\n\n## Tests\nPassed.",
    ),
    { kind: "notes", entries: ["Fixed cue playback."] },
  );
  assert.deepEqual(
    parseReleaseNote(
      "Notes:\n- Added cue controls.\n* Fixed playback.\n\n## Tests",
    ),
    { kind: "notes", entries: ["Added cue controls.", "Fixed playback."] },
  );
  assert.deepEqual(
    parseReleaseNote(
      "<!-- Notes: example -->\n```md\nNotes: example\n```\nNotes: none (only changes test coverage)",
    ),
    { kind: "none", reason: "only changes test coverage", entries: [] },
  );
  assert.deepEqual(parseReleaseNote("Notes: Fixed playback.\r\n"), {
    kind: "notes",
    entries: ["Fixed playback."],
  });
});

/** Missing declarations and accidental template defaults cannot satisfy the required check. */
test("rejects missing, duplicate, empty and malformed declarations", () => {
  for (const body of [
    undefined,
    "",
    "Notes:",
    "Notes: none",
    "Notes: none ()",
    "Notes: none (TODO)",
    "Notes: none (tests)\n- Fixed playback.",
    "Notes: TBD",
    "Notes: <describe change>",
    "Notes:\n- ",
    "Notes:\nFixed something",
    "Notes: Fixed playback.\nNotes: none (tests)",
    "```\nNotes: Fixed playback.\n```",
    "Notes:\n- none",
    "Notes: Fixed playback.\n- Added controls.",
  ]) {
    assert.throws(() => parseReleaseNote(body), /Notes:|Multiline|omission/);
  }
});

/** Provides isolated real Git ancestry without inheriting the user's signing settings or hooks. */
function repositoryFixture(t) {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "nightfall-release-notes-"));
  process.chdir(directory);
  t.after(() => {
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
  });
  /** Runs fixture Git commands without invoking any project tooling. */
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-b", "main");
  /** Makes a distinct content commit and returns its immutable ID. */
  const commit = (name) => {
    writeFileSync(name, name);
    git("add", name);
    git("commit", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const base = commit("initial");
  git("tag", "v0.1.0");
  return { git, commit, base };
}

/** Supplies the subset of GitHub PR metadata needed for release membership and prose. */
function pull(number, sha, body, overrides = {}) {
  return {
    number,
    title: "fix(engine:desk): implementation detail",
    body,
    merged_at: "2026-09-23T00:00:00Z",
    merge_commit_sha: sha,
    base: { ref: "develop", repo: { full_name: "owner/repo" } },
    head: { ref: "feature", sha, repo: { full_name: "owner/repo" } },
    ...overrides,
  };
}

/** Normal promotion merges preserve original notes once, omit explicit skips, and expose direct commits. */
test("collects all-parent ancestry and deduplicates PR associations", (t) => {
  const { git, commit, base } = repositoryFixture(t);
  git("switch", "-c", "develop");
  const feature = commit("feature");
  const skip = commit("tests");
  const direct = commit("direct");
  git("switch", "main");
  git("merge", "--no-ff", "develop", "-m", "promotion");
  const target = git("rev-parse", "HEAD");
  const featurePR = pull(1, feature, "Notes: Fixed cue playback.");
  const skipPR = pull(2, skip, "Notes: none (test coverage only)");
  const promotion = pull(
    3,
    target,
    "Notes: none (promotes changes already described by their PRs)",
    {
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      head: { ref: "develop", sha: direct, repo: { full_name: "owner/repo" } },
    },
  );
  const future = pull(4, "not-in-range", "Notes: Future changes.");
  const old = pull(5, base, "Notes: Old changes.");
  const responses = new Map([
    [feature, [featurePR, promotion, future, old]],
    [skip, [skipPR]],
    [direct, [promotion]],
    [target, [promotion]],
  ]);
  const report = collectReleaseNotes(
    "owner/repo",
    "v0.1.0",
    "HEAD",
    (_repo, endpoint) => responses.get(endpoint.split("/")[1]),
  );
  assert.equal(report.notes.length, 1);
  assert.deepEqual(report.notes[0].entries, ["Fixed cue playback."]);
  assert.deepEqual(
    report.omitted.map((entry) => entry.number),
    [2, 3],
  );
  assert.deepEqual(report.unmatched, [{ sha: direct, subject: "direct" }]);
  const markdown = renderReleaseNotes(report, "Download the installer.");
  assert.match(markdown, /### Fixes\n\n- Fixed cue playback\./);
  assert.doesNotMatch(
    markdown,
    /implementation detail|test coverage only|Future changes|Old changes/,
  );
  assert.match(markdown, /### Additional commits/);
  assert.match(markdown, /## Installation\n\nDownload the installer\./);
});

/** Misconfigured promotions fail visibly instead of dropping the original PR entries. */
test("rejects squashed develop promotions", (t) => {
  const { git, commit } = repositoryFixture(t);
  git("switch", "-c", "develop");
  const feature = commit("feature");
  git("switch", "main");
  git("merge", "--squash", "develop");
  git("commit", "-m", "squashed promotion");
  const target = git("rev-parse", "HEAD");
  const pr = pull(9, target, "Notes: none (promotion)", {
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    head: { ref: "develop", sha: feature, repo: { full_name: "owner/repo" } },
  });
  assert.throws(
    () => collectReleaseNotes("owner/repo", "v0.1.0", "HEAD", () => [pr]),
    /Preserve promotion ancestry/,
  );
});

/** Notes deleted after merge and GitHub failures stop generation rather than silently skipping a PR. */
test("fails on invalid merged PR notes and unavailable metadata", (t) => {
  const { commit } = repositoryFixture(t);
  const sha = commit("feature");
  assert.throws(
    () =>
      collectReleaseNotes("owner/repo", "v0.1.0", "HEAD", () => [
        pull(7, sha, ""),
      ]),
    /PR #7/,
  );
  assert.throws(
    () =>
      collectReleaseNotes("owner/repo", "v0.1.0", "HEAD", () => {
        throw new Error("API unavailable");
      }),
    /API unavailable/,
  );
});

/** Published ancestry determines the baseline even when an unrelated release is newer. */
test("selects the nearest published ancestor and excludes drafts and the current tag", (t) => {
  const { git, commit, base } = repositoryFixture(t);
  git("switch", "-c", "unrelated");
  commit("unrelated");
  git("tag", "v9.0.0");
  git("switch", "main");
  commit("alpha");
  git("tag", "v0.2.0-alpha.1");
  commit("draft");
  git("tag", "v0.2.0-alpha.2");
  const target = commit("current");
  git("tag", "v0.2.0");
  const releases = [
    { tag_name: "v0.2.0" },
    { tag_name: "v9.0.0" },
    { tag_name: "v0.2.0-alpha.2", draft: true },
    { tag_name: "v0.1.0" },
    { tag_name: "v0.2.0-alpha.1", prerelease: true },
  ];
  assert.equal(
    previousRelease("owner/repo", target, () => releases),
    "v0.2.0-alpha.1",
  );
  assert.throws(
    () => previousRelease("owner/repo", base, () => []),
    /Supply --from/,
  );
  assert.throws(
    () => collectReleaseNotes("owner/repo", "v9.0.0", "HEAD", () => []),
    /must be an ancestor/,
  );
});
