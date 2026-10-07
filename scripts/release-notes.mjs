// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Reads one user-facing Notes declaration, ignoring template comments and code examples. */
export function parseReleaseNote(body = "") {
  let fence = null;
  const lines = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const prose = [];
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
        fence = null;
      continue;
    }
    if (!fence) prose.push(line);
  }
  const starts = prose.flatMap((line, index) =>
    /^ {0,3}Notes:/i.test(line) ? [index] : [],
  );
  if (starts.length !== 1)
    throw new Error(
      "Include exactly one Notes: entry, or Notes: none (reason), in the PR description.",
    );
  const first = prose[starts[0]].replace(/^ {0,3}Notes:\s*/i, "").trim();
  const following = [];
  for (const line of prose.slice(starts[0] + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) break;
    following.push(line.trim());
  }
  if (first && following.length)
    throw new Error(
      "Use one Notes: sentence, or put each entry on a bullet below an empty Notes: line.",
    );
  if (/^none\b/i.test(first)) {
    const reason = first.match(/^none\s+\((.+)\)\.?$/i)?.[1].trim();
    if (!reason || isPlaceholder(reason))
      throw new Error("An omission must use Notes: none (a specific reason).");
    return { kind: "none", reason, entries: [] };
  }
  if (!first && following.some((line) => !/^[-*] \S/.test(line)))
    throw new Error(
      "Multiline Notes: must contain one complete entry per bullet.",
    );
  const entries = first
    ? [first]
    : following.map((line) => line.slice(2).trim());
  if (
    !entries.length ||
    entries.some((entry) => isPlaceholder(entry) || /^none\b/i.test(entry))
  )
    throw new Error(
      "Replace the empty or placeholder Notes: entry with user-facing prose.",
    );
  return { kind: "notes", entries };
}

/** Rejects unfilled template values without trying to judge the quality of human prose. */
function isPlaceholder(text) {
  return (
    !/[\p{L}\p{N}]/u.test(text) ||
    /^(?:todo|tbd|n\/?a|none|\.\.\.|<.*>|\[.*\])\.?$/i.test(text)
  );
}

/** Runs read-only Git commands with bounded output and no shell interpretation. */
function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Reads every page of a GitHub REST list, propagating failures instead of omitting changes. */
export function githubList(repository, endpoint) {
  const pages = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repository}/${endpoint}`],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    ),
  );
  return pages.flat();
}

/** Reads only explicitly supported API snapshots; missing metadata never falls back to authentication. */
export function snapshotList(directory) {
  /** Maps release and commit-association endpoints to data files collected by the read-only job. */
  return (_repository, endpoint) => {
    const commit = endpoint.match(
      /^commits\/([a-f0-9]{40})\/pulls\?per_page=100$/,
    );
    const filename =
      endpoint === "releases?per_page=100"
        ? "releases.json"
        : commit
          ? `commits/${commit[1]}.json`
          : null;
    if (!filename)
      throw new Error(`Unsupported metadata endpoint: ${endpoint}`);
    const data = JSON.parse(readFileSync(join(directory, filename), "utf8"));
    if (!Array.isArray(data))
      throw new Error(`Expected an API list: ${filename}`);
    return data;
  };
}

/** Tests reachability while distinguishing unrelated commits from Git failures. */
export function isAncestor(ancestor, descendant) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/** Resolves refs to commit IDs so user input cannot become revision-walking options. */
function commitId(ref) {
  return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

/** Chooses the closest ancestral published release, including prereleases, rather than the latest by date. */
export function previousRelease(repository, target, list = githubList) {
  const candidates = [];
  for (const release of list(repository, "releases?per_page=100")) {
    if (
      release.draft ||
      !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag_name)
    )
      continue;
    const sha = commitId(`refs/tags/${release.tag_name}`);
    if (sha === target || !isAncestor(sha, target)) continue;
    candidates.push({
      tag: release.tag_name,
      distance: Number(git(["rev-list", "--count", `${sha}..${target}`])),
    });
  }
  candidates.sort(
    (a, b) => a.distance - b.distance || a.tag.localeCompare(b.tag),
  );
  if (!candidates.length)
    throw new Error(
      "No ancestral published release found. Supply --from explicitly for the first release.",
    );
  return candidates[0].tag;
}

/** Identifies branch promotions whose notes cannot stand in for the individual changes they carry. */
function isPromotion(pr, repository) {
  return (
    pr.base.ref === "main" &&
    pr.head.ref === "develop" &&
    pr.head.repo?.full_name === repository
  );
}

/** Resolves an ancestral range and enumerates every commit whose PR associations are needed. */
export function releaseRange(from, to) {
  const base = commitId(from);
  const target = commitId(to);
  if (!isAncestor(base, target))
    throw new Error(`${from} must be an ancestor of ${to}.`);
  const commits = git([
    "rev-list",
    "--reverse",
    "--topo-order",
    `${base}..${target}`,
  ])
    .split("\n")
    .filter(Boolean);
  return { base, target, commits };
}

/** Collects original merged PRs from all parents of the release range, deduplicating promotion associations. */
export function collectReleaseNotes(repository, from, to, list = githubList) {
  const { base, target, commits } = releaseRange(from, to);
  const included = new Set(commits);
  const pulls = new Map();
  const unmatched = [];
  for (const sha of commits) {
    const associated = list(
      repository,
      `commits/${sha}/pulls?per_page=100`,
    ).filter(
      (pr) =>
        pr.merged_at &&
        pr.base.repo.full_name === repository &&
        included.has(pr.merge_commit_sha) &&
        (!isPromotion(pr, repository) || pr.merge_commit_sha === sha),
    );
    if (!associated.length)
      unmatched.push({ sha, subject: git(["show", "-s", "--format=%s", sha]) });
    for (const pr of associated) pulls.set(pr.number, pr);
  }
  const notes = [];
  const omitted = [];
  for (const pr of [...pulls.values()].sort((a, b) => a.number - b.number)) {
    if (isPromotion(pr, repository) && !isAncestor(pr.head.sha, target))
      throw new Error(
        `PR #${pr.number} squashed or rebased develop into main. Preserve promotion ancestry with a merge so original release notes can be collected.`,
      );
    let note;
    try {
      note = parseReleaseNote(pr.body);
    } catch (error) {
      throw new Error(`PR #${pr.number}: ${error.message}`);
    }
    if (note.kind === "none")
      omitted.push({ number: pr.number, reason: note.reason });
    else
      notes.push({
        number: pr.number,
        category: /^fix(?:\(|!|:)/i.test(pr.title)
          ? "Fixes"
          : /^feat(?:\(|!|:)/i.test(pr.title)
            ? "Improvements"
            : "Changes",
        entries: note.entries,
      });
  }
  return { repository, from, to, base, target, notes, omitted, unmatched };
}

/** Renders reviewed prose and exposes unmatched commits so direct pushes cannot silently disappear. */
export function renderReleaseNotes(report, installationNotes) {
  const sections = ["## What's changed"];
  for (const category of ["Improvements", "Fixes", "Changes"]) {
    const entries = report.notes
      .filter((note) => note.category === category)
      .flatMap((note) =>
        note.entries.map(
          (entry) =>
            `- ${entry} ([#${note.number}](https://github.com/${report.repository}/pull/${note.number}))`,
        ),
      );
    if (entries.length)
      sections.push(`### ${category}\n\n${entries.join("\n")}`);
  }
  if (!report.notes.length)
    sections.push(
      "No user-facing changes were declared in the included pull requests.",
    );
  if (report.unmatched.length)
    sections.push(
      `### Additional commits\n\n${report.unmatched.map(({ sha, subject }) => `- ${subject} ([${sha.slice(0, 7)}](https://github.com/${report.repository}/commit/${sha}))`).join("\n")}`,
    );
  sections.push(
    `[Full comparison](https://github.com/${report.repository}/compare/${report.base}...${report.target})`,
  );
  if (installationNotes.trim())
    sections.push(`## Installation\n\n${installationNotes.trim()}`);
  return `${sections.join("\n\n")}\n`;
}

/** Validates live PR metadata or generates release Markdown plus a reproducible metadata snapshot. */
function main() {
  const { positionals, values } = parseArgs({
    options: {
      repo: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
      metadata: { type: "string" },
    },
    allowPositionals: true,
  });
  const repository = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("Supply --repo owner/repository.");
  if (positionals[0] === "check") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const number = event.pull_request?.number;
    if (!Number.isSafeInteger(number))
      throw new Error("Expected a pull request event.");
    const pr = JSON.parse(
      values.metadata
        ? readFileSync(join(values.metadata, "pr.json"), "utf8")
        : execFileSync("gh", ["api", `repos/${repository}/pulls/${number}`], {
            encoding: "utf8",
          }),
    );
    if (pr.number !== number)
      throw new Error("PR metadata does not match the event.");
    const note = parseReleaseNote(pr.body);
    const summary =
      note.kind === "none"
        ? `Omitted: ${note.reason}`
        : note.entries.map((entry) => `- ${entry}`).join("\n");
    process.stdout.write(`${summary}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Release note preview\n\n${summary}\n`,
      );
  } else if (
    ["plan", "generate"].includes(positionals[0]) &&
    values.to &&
    values.output
  ) {
    const list = values.metadata ? snapshotList(values.metadata) : githubList;
    const target = commitId(values.to);
    const from = values.from ?? previousRelease(repository, target, list);
    if (positionals[0] === "plan") {
      writeFileSync(
        values.output,
        `${JSON.stringify(releaseRange(from, values.to).commits)}\n`,
      );
      return;
    }
    const report = collectReleaseNotes(repository, from, values.to, list);
    writeFileSync(
      values.output,
      renderReleaseNotes(
        report,
        readFileSync(".github/desktop-release-notes.md", "utf8"),
      ),
    );
    writeFileSync(
      values.report ?? `${values.output}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.stdout.write(
      `Collected ${report.notes.length} PRs; ${report.omitted.length} explicit omissions; ${report.unmatched.length} unmatched commits.\n`,
    );
  } else
    throw new Error(
      "Usage: release-notes.mjs check --repo OWNER/REPO [--metadata DIR] | plan|generate --repo OWNER/REPO --to REF --output FILE [--from REF] [--report FILE] [--metadata DIR]",
    );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main();
