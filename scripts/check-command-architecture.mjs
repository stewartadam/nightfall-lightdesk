#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([".rs", ".ts", ".tsx"]);
const retiredRules = [
  ["CommandStatus", /\bCommandStatus\b/g],
  ["CommandResultCandidate", /\bCommandResultCandidate\b/g],
  ["Correlated<T>", /\bCorrelated\b/g],
  ["BatchIdTracker", /\bBatchIdTracker\b/g],
  ["PayloadRouter", /\bPayloadRouter\b/g],
  ["batch_id", /\bbatch_id\b/g],
  ["ActionPayload", /\bActionPayload\b/g],
  ["direct CommandResult writer", /\bMessageWriter\s*<\s*CommandResult\b/g],
];
const engineDomainOwnershipRules = [
  ["engine-owned UserCommand", /\bUserCommand\b/g],
  ["engine-owned ActionPlanner", /\bActionPlanner\b/g],
  ["engine-owned ProgrammerAction", /\bProgrammerAction\b/g],
  ["engine-owned PlaybackAction", /\bPlaybackAction\b/g],
  ["engine-owned DmxAction", /\bDmxAction\b/g],
  ["engine-owned CueLifecycleAction", /\bCueLifecycleAction\b/g],
];
const timelineDomainCouplingRules = [
  ["timeline-owned desk action ID", /\bCLIP_(?:START|STOP|GO)_ACTION_ID\b/g],
  ["timeline-owned desk action decoder", /\bclip_target_for_action\b/g],
  ["timeline-owned desk eval decoder", /\bdesk_eval_command_for_action\b/g],
];

/** Returns source files in lifecycle-sensitive production directories. */
function repositorySourcePaths() {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "crates",
      "webui",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error("git ls-files failed");
  }
  return result.stdout
    .split("\n")
    .filter((path) => sourceExtensions.has(extname(path)));
}

/** Returns the one-based line containing a character offset. */
function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** Finds retired lifecycle constructs in supplied path/source records. */
export function findRetiredLifecycleUses(sources) {
  const violations = [];
  for (const { path, source } of sources) {
    for (const [name, pattern] of retiredRules) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        violations.push({
          line: lineNumberAt(source, match.index),
          name,
          path,
        });
      }
    }
    if (path.startsWith("crates/engine/")) {
      for (const [name, pattern] of engineDomainOwnershipRules) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          violations.push({
            line: lineNumberAt(source, match.index),
            name,
            path,
          });
        }
      }
    }
    if (
      path.startsWith("crates/timeline/src/") &&
      !path.includes("/tests/") &&
      !path.endsWith("/tests.rs")
    ) {
      for (const [name, pattern] of timelineDomainCouplingRules) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          violations.push({
            line: lineNumberAt(source, match.index),
            name,
            path,
          });
        }
      }
    }
  }
  return violations;
}

/** Reads repository sources and fails when retired lifecycle constructs return. */
function main() {
  const sources = repositorySourcePaths().map((path) => ({
    path,
    source: readFileSync(join(repoRoot, path), "utf8"),
  }));
  const violations = findRetiredLifecycleUses(sources);
  if (violations.length === 0) {
    console.log("Command architecture check passed");
    return;
  }

  console.error("Retired command architecture constructs found:");
  for (const violation of violations) {
    console.error(`  ${violation.path}:${violation.line}: ${violation.name}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main();
}
