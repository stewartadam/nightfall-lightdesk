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
    if (restore === "exact hit")
      lines.push(
        "",
        "The exact-hit cache was missing these units, so a cancelled or failed run probably saved it mid-build. rust-cache never re-saves an exact hit; it is replaced when the lockfile or toolchain changes.",
      );
  }
  return `${lines.join("\n")}\n`;
}

/** Lists the names of a directory's subdirectories. */
function subdirectories(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Lists every compilation unit's fingerprint directory under a build directory,
 * for host profiles (`<dir>/<profile>`) and cross-compiled ones
 * (`<dir>/<triple>/<profile>`). Handles Cargo's classic layout
 * (`<profile>/.fingerprint/<package>-<hash>`) and the newer per-package layout
 * (`<profile>/build/<package>/<hash>/fingerprint`). Other trees such as `doc`
 * are not walked.
 */
export function findUnitDirectories(buildDir) {
  const units = [];
  /** Records the units of one profile directory, if it is one. */
  function visitProfile(profileDir) {
    let isProfile = false;
    const classic = path.join(profileDir, ".fingerprint");
    if (existsSync(classic)) {
      isProfile = true;
      for (const name of subdirectories(classic)) {
        units.push({
          package: unitPackage(name),
          directory: path.join(classic, name),
        });
      }
    }
    const perPackage = path.join(profileDir, "build");
    if (existsSync(perPackage)) {
      isProfile = true;
      for (const name of subdirectories(perPackage)) {
        for (const hash of subdirectories(path.join(perPackage, name))) {
          const fingerprint = path.join(perPackage, name, hash, "fingerprint");
          if (existsSync(fingerprint))
            units.push({ package: name, directory: fingerprint });
        }
      }
    }
    return isProfile;
  }
  if (!existsSync(buildDir)) return units;
  for (const name of subdirectories(buildDir)) {
    const entryPath = path.join(buildDir, name);
    if (!visitProfile(entryPath)) {
      for (const profile of subdirectories(entryPath))
        visitProfile(path.join(entryPath, profile));
    }
  }
  return units;
}

/** Reads each unit's package name and the newest mtime of its fingerprint files. */
export function readUnits(unitDirectories) {
  return unitDirectories.map(({ package: name, directory }) => {
    let modifiedMs = 0;
    for (const file of readdirSync(directory)) {
      modifiedMs = Math.max(
        modifiedMs,
        statSync(path.join(directory, file)).mtimeMs,
      );
    }
    return { package: name, modifiedMs };
  });
}

/** Asks Cargo for the workspace build directory and member package names, without touching the network. */
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
    buildDir: metadata.build_directory ?? metadata.target_directory,
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
    findUnitDirectories(workspaceMetadata().buildDir).length > 0;
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
    const { buildDir, packages } = workspaceMetadata();
    summary = summarizeUnits(
      readUnits(findUnitDirectories(buildDir)),
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
