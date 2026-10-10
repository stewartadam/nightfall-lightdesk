#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Prefixes git gives commits that `rebase --autosquash` folds into another commit. */
const AUTOSQUASH_PREFIXES = ["fixup!", "squash!", "amend!"];

/**
 * Parses a `Name <email>` identity, ignoring anything after the closing bracket
 * such as the timestamp `git var GIT_AUTHOR_IDENT` appends.
 */
export function parseIdentity(text) {
  const match = /^\s*(.*?)\s*<([^>]*)>/.exec(text);
  if (!match) return null;
  return { name: match[1], email: match[2] };
}

/** Lists the identities in a commit message's `Signed-off-by:` trailers, skipping comment lines. */
export function signoffIdentities(message) {
  return message
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => /^Signed-off-by:\s*(.*)$/i.exec(line))
    .filter(Boolean)
    .map((match) => parseIdentity(match[1]))
    .filter(Boolean);
}

/**
 * Explains why a commit message fails the Developer Certificate of Origin check,
 * or returns null when it passes.
 *
 * The DCO check on pull requests requires a sign-off whose email matches the
 * commit author's, compared case-insensitively. Autosquash commits are exempt
 * because they disappear into the commit they fix.
 */
export function signoffProblem(message, author) {
  const subject = message
    .split("\n")
    .find((line) => line.trim() && !line.startsWith("#"));
  if (AUTOSQUASH_PREFIXES.some((prefix) => subject?.startsWith(prefix))) {
    return null;
  }
  const signoffs = signoffIdentities(message);
  const authorEmail = author.email.toLowerCase();
  if (signoffs.some(({ email }) => email.toLowerCase() === authorEmail)) {
    return null;
  }
  const expected = `Signed-off-by: ${author.name} <${author.email}>`;
  if (signoffs.length === 0) {
    return `The commit message has no sign-off. Commit with -s, or add:\n  ${expected}`;
  }
  const found = signoffs
    .map(({ name, email }) => `  Signed-off-by: ${name} <${email}>`)
    .join("\n");
  return `No sign-off matches the commit author <${author.email}>. Found:\n${found}\nAdd:\n  ${expected}`;
}

/** Reads the author git will record for the commit being made, honoring --author and amends. */
function commitAuthor() {
  const ident = execFileSync("git", ["var", "GIT_AUTHOR_IDENT"], {
    encoding: "utf8",
  });
  const author = parseIdentity(ident);
  if (!author) throw new Error(`Unrecognized author identity: ${ident}`);
  return author;
}

/** Reports whether the commit being made concludes a merge, which carries no authored changes to sign off. */
function isMergeCommit() {
  const mergeHead = execFileSync(
    "git",
    ["rev-parse", "--git-path", "MERGE_HEAD"],
    { encoding: "utf8" },
  ).trim();
  return existsSync(mergeHead);
}

/** Runs the commit-msg hook against the message file git passes as the first argument. */
function main() {
  const messagePath = process.argv[2];
  if (!messagePath) {
    console.error("usage: check-commit-signoff.mjs <commit-message-file>");
    process.exit(2);
  }
  if (isMergeCommit()) return;
  const problem = signoffProblem(
    readFileSync(messagePath, "utf8"),
    commitAuthor(),
  );
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
