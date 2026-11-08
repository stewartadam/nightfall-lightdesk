// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The largest PR, in changed files and in added plus deleted lines, that can merge without a human. */
export const limits = { files: 20, lines: 400 };

// Areas where a mistake is costly or hard to undo. A PR touching any of them always needs a human,
// whatever the review finds. The review workflow runs from the default branch, so a PR cannot
// loosen this list, the rubric or the workflow for itself.
export const riskyAreas = [
  {
    // Required checks run these from the PR itself, so a change here can weaken the checks the
    // auto-merge waits for.
    area: "CI, build and test tooling",
    patterns: [
      /^\.github\//,
      /^scripts\//,
      /^\.pre-commit-config\.yaml$/,
      /^\.config\//,
      /^(playwright|playwright\/[^/]+|vite)\.config\.ts$/,
      /^(biome|\.knip)\.jsonc$/,
      /^tsconfig[^/]*\.json$/,
      /^\.(clippy|rustfmt)\.toml$/,
      /^\.nvmrc$/,
    ],
  },
  {
    area: "dependencies and toolchain",
    patterns: [
      /(^|\/)Cargo\.toml$/,
      /^Cargo\.lock$/,
      /(^|\/)package\.json$/,
      /^pnpm-(lock|workspace)\.yaml$/,
      /^rust-toolchain\.toml$/,
      /^config\/cargo-tools\.json$/,
      /^patches\//,
      /^\.cargo\//,
      /^crates\/workspace-hack\//,
    ],
  },
  {
    area: "showfile format and migrations",
    patterns: [/^crates\/showfile\//],
  },
  {
    area: "client and server protocol",
    patterns: [/^crates\/websocket\//],
  },
  {
    // A mistake here reaches fixtures and other consoles on the network during a show.
    area: "DMX, network and controller input and output",
    patterns: [/^crates\/(input|output)_/],
  },
  {
    area: "desktop app, installers and updates",
    patterns: [/^desktop\//],
  },
  {
    area: "licensing",
    patterns: [
      /^LICENSE$/,
      /^about\.toml$/,
      /^config\/(license-headers|notices)\//,
    ],
  },
  {
    area: "agent instructions",
    // Claude Code loads CLAUDE.md files it finds in the PR's tree as instructions, nested ones too.
    patterns: [
      /(^|\/)(AGENTS|CLAUDE)(\.local)?\.md$/,
      /(^|\/)\.(agents|claude)\//,
    ],
  },
  {
    area: "Git LFS and attributes",
    patterns: [/^\.gitattributes$/],
  },
];

/**
 * Decide whether a PR is small and contained enough for the Claude review to clear it for
 * auto-merge. Takes the PR's file entries as the GitHub pull request files API returns them
 * (`filename`, optional `previous_filename`, `additions`, `deletions`) and checks both sides of
 * renames, so moving a file out of a risky area still counts as touching it. Returns whether the
 * PR is eligible, the human-readable reasons when it is not, and the size it measured.
 */
export function assessMergeRisk(files, policy = { limits, riskyAreas }) {
  const lines = files.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );
  const reasons = [];
  if (files.length === 0) reasons.push("The PR changes no files.");
  if (files.length > policy.limits.files) {
    reasons.push(
      `Changes ${files.length} files; auto-merge allows at most ${policy.limits.files}.`,
    );
  }
  if (lines > policy.limits.lines) {
    reasons.push(
      `Changes ${lines} lines; auto-merge allows at most ${policy.limits.lines}.`,
    );
  }
  // The files API reports binary files, LFS media included, with no line counts, so the size
  // limit cannot measure them and the review cannot read them.
  const binary = files
    .filter(
      (file) =>
        ["added", "modified"].includes(file.status) &&
        !file.additions &&
        !file.deletions,
    )
    .map((file) => file.filename);
  if (binary.length > 0) {
    reasons.push(`Changes binary files: ${summarizePaths(binary)}.`);
  }
  const paths = files.flatMap((file) =>
    file.previous_filename
      ? [file.filename, file.previous_filename]
      : [file.filename],
  );
  for (const { area, patterns } of policy.riskyAreas) {
    const touched = [
      ...new Set(
        paths.filter((path) => patterns.some((pattern) => pattern.test(path))),
      ),
    ];
    if (touched.length > 0) {
      reasons.push(`Touches ${area}: ${summarizePaths(touched)}.`);
    }
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    files: files.length,
    lines,
  };
}

/** List the first three paths in code spans and count the rest, so the verdict comment stays short. */
function summarizePaths(paths) {
  const shown = paths.slice(0, 3).map((path) => `\`${path}\``);
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `${shown.join(", ")}${more}`;
}

/** Parse the newline-delimited JSON file entries the metadata job snapshots from the GitHub API. */
export function readFileEntries(contents) {
  return contents
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output] = process.argv.slice(2);
  const assessment = assessMergeRisk(
    readFileEntries(readFileSync(input, "utf8")),
  );
  writeFileSync(output, `${JSON.stringify(assessment, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `eligible=${assessment.eligible}\nassessment=${JSON.stringify(assessment)}\n`,
    );
  }
}
