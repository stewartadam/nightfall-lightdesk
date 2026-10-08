// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Matches the metadata hash Cargo appends to every unit's fingerprint directory. */
const UNIT_HASH = /-[0-9a-f]{16}$/;

/**
 * Describes how the cache restore went, from rust-cache's exact-match output and
 * whether any compiled artifacts were present right after the restore.
 */
export function describeRestore({ exactHit, targetsCached, artifactsPresent }) {
  if (exactHit) return "exact hit";
  if (!targetsCached) return "no exact hit";
  return artifactsPresent ? "partial hit (older cache)" : "miss";
}

/** Strips Cargo's metadata hash from a fingerprint directory name to get its package name. */
export function unitPackage(directoryName) {
  return directoryName.replace(UNIT_HASH, "");
}

/**
 * Splits compilation units into cached and rebuilt groups, separating workspace
 * packages from dependencies. A unit counts as rebuilt when Cargo wrote any of its
 * fingerprint files at or after the restore time, which callers truncate to whole
 * seconds so coarse filesystem timestamps still compare correctly.
 */
export function summarizeUnits(units, workspacePackages, restoredAtMs) {
  const summary = {
    dependencies: { cached: 0, rebuilt: 0, rebuiltPackages: new Set() },
    workspace: { cached: 0, rebuilt: 0, rebuiltPackages: new Set() },
  };
  for (const unit of units) {
    const group = workspacePackages.has(unit.package)
      ? summary.workspace
      : summary.dependencies;
    if (unit.modifiedMs >= restoredAtMs) {
      group.rebuilt += 1;
      group.rebuiltPackages.add(unit.package);
    } else {
      group.cached += 1;
    }
  }
  return summary;
}

/** Renders the job-summary Markdown for one cache restore and the build that followed. */
export function renderReport({
  label,
  restore,
  summary,
  rebuiltListLimit = 25,
}) {
  const lines = [`### Rust cache: ${label}`, "", `Restore: **${restore}**`];
  if (!summary) return `${lines.join("\n")}\n`;

  const { dependencies, workspace } = summary;
  const total =
    dependencies.cached +
    dependencies.rebuilt +
    workspace.cached +
    workspace.rebuilt;
  if (total === 0) {
    lines.push(
      "",
      "No Cargo compilation units were found in the target directory.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "",
    `Rebuilt **${dependencies.rebuilt}** dependency units (${dependencies.rebuiltPackages.size} packages) and **${workspace.rebuilt}** workspace units.`,
    "",
    "| Units | From cache, not rebuilt | Rebuilt |",
    "| --- | ---: | ---: |",
    `| Dependencies | ${dependencies.cached} | ${dependencies.rebuilt} |`,
    `| Workspace | ${workspace.cached} | ${workspace.rebuilt} |`,
    "",
    "Units from cache can include stale ones this job did not use, for example after a partial hit.",
  );
  if (dependencies.rebuiltPackages.size > 0) {
    const names = [...dependencies.rebuiltPackages].sort();
    const shown = names.slice(0, rebuiltListLimit).map((name) => `\`${name}\``);
    const more =
      names.length > shown.length
        ? `, and ${names.length - shown.length} more`
        : "";
    lines.push("", `Rebuilt dependencies: ${shown.join(", ")}${more}.`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Lists the `.fingerprint` directory of every profile under a target directory:
 * host profiles (`target/<profile>`) and cross-compiled ones
 * (`target/<triple>/<profile>`). Other trees such as `target/doc` are not walked.
 */
export function findFingerprintDirectories(targetDir) {
  const found = [];
  /** Records profile directories below `directory`, looking one level deeper when `nested`. */
  function visit(directory, nested) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      const fingerprints = path.join(entryPath, ".fingerprint");
      if (existsSync(fingerprints)) found.push(fingerprints);
      else if (nested) visit(entryPath, false);
    }
  }
  if (existsSync(targetDir)) visit(targetDir, true);
  return found;
}

/** Reads each unit under the given fingerprint directories with the newest mtime of its files. */
export function readUnits(fingerprintDirectories) {
  const units = [];
  for (const directory of fingerprintDirectories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const unitPath = path.join(directory, entry.name);
      let modifiedMs = 0;
      for (const file of readdirSync(unitPath)) {
        modifiedMs = Math.max(
          modifiedMs,
          statSync(path.join(unitPath, file)).mtimeMs,
        );
      }
      units.push({ package: unitPackage(entry.name), modifiedMs });
    }
  }
  return units;
}

/** Asks Cargo for the workspace target directory and member package names, without touching the network. */
function workspaceMetadata() {
  const output = execFileSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--offline"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const metadata = JSON.parse(output);
  return {
    targetDir: metadata.target_directory,
    packages: new Set(metadata.packages.map((pkg) => pkg.name)),
  };
}

/** Appends a line to a GitHub Actions command file such as `GITHUB_STATE`. */
async function appendCommandFile(variable, line) {
  const file = process.env[variable];
  if (!file) throw new Error(`${variable} is not set`);
  await appendFile(file, `${line}\n`);
}

/**
 * Records the restore time and outcome right after rust-cache restores, so the post
 * step can tell which units the job's builds wrote.
 */
export async function begin() {
  const restoredAtMs = Math.floor(Date.now() / 1000) * 1000;
  const artifactsPresent =
    process.env.INPUT_TARGETS !== "false" &&
    findFingerprintDirectories(workspaceMetadata().targetDir).some(
      (directory) => readdirSync(directory).length > 0,
    );
  await appendCommandFile("GITHUB_STATE", `restored_at=${restoredAtMs}`);
  await appendCommandFile(
    "GITHUB_STATE",
    `artifacts_present=${artifactsPresent}`,
  );
}

/** Writes the cache report to the job summary once the job's Cargo builds have finished. */
export async function report() {
  const restoredAtMs = Number(process.env.STATE_restored_at);
  if (!restoredAtMs) {
    console.log(
      "No restore time was recorded; skipping the Rust cache report.",
    );
    return;
  }
  const targetsCached = process.env.INPUT_TARGETS !== "false";
  const restore = describeRestore({
    exactHit: process.env.INPUT_RESTORED === "true",
    targetsCached,
    artifactsPresent: process.env.STATE_artifacts_present === "true",
  });
  let summary;
  if (targetsCached) {
    const { targetDir, packages } = workspaceMetadata();
    summary = summarizeUnits(
      readUnits(findFingerprintDirectories(targetDir)),
      packages,
      restoredAtMs,
    );
  }
  const markdown = renderReport({
    label: process.env.INPUT_LABEL || "rust",
    restore,
    summary,
  });
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Runs one report command, downgrading any failure to a warning so the report never fails the job. */
export async function run(command) {
  try {
    if (command === "begin") await begin();
    else if (command === "report") await report();
    else
      throw new Error(
        `Usage: cargo-cache-report.mjs begin|report (got ${command})`,
      );
  } catch (error) {
    console.log(`::warning::Rust cache report failed: ${error.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run(process.argv[2]);
}
