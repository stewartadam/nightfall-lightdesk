// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { noticesJson, noticesText } from "./distribution-notices.mjs";

export const desktopTargets = [
  {
    runner: "macos-15",
    target: "aarch64-apple-darwin",
    bundles: "dmg",
    extensions: [".dmg"],
  },
  {
    runner: "windows-2022",
    target: "x86_64-pc-windows-msvc",
    bundles: "nsis",
    extensions: [".exe"],
  },
  {
    runner: "ubuntu-22.04",
    target: "x86_64-unknown-linux-gnu",
    bundles: "deb,appimage",
    extensions: [".deb", ".AppImage"],
  },
];

/** Requires matching app versions and permits publication only for an exact version-tag push. */
export function desktopReleasePolicy(version, crateVersion, eventName, ref) {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
  ) {
    throw new Error(
      "The Tauri application version must be a concrete semantic version",
    );
  }
  if (version !== crateVersion) {
    throw new Error(
      `Tauri version ${version} differs from Cargo version ${crateVersion}`,
    );
  }
  const publish = eventName === "push" && ref.startsWith("refs/tags/");
  if (publish && ref !== `refs/tags/v${version}`) {
    throw new Error(
      `Release tag must be v${version}, matching the Tauri and Cargo versions`,
    );
  }
  return { version, publish, prerelease: version.includes("-") };
}

/** Selects every requested installer and gives it an unambiguous version/architecture filename. */
export function desktopArtifactPlan(target, version, artifactPaths) {
  const platform = desktopTargets.find((entry) => entry.target === target);
  if (!platform) throw new Error(`Unknown desktop target: ${target}`);
  desktopReleasePolicy(version, version, "workflow_dispatch", "");
  if (
    !Array.isArray(artifactPaths) ||
    artifactPaths.some((path) => typeof path !== "string")
  ) {
    throw new Error("Tauri artifact paths must be an array of paths");
  }
  return platform.extensions.map((extension) => {
    const matches = artifactPaths.filter((path) => path.endsWith(extension));
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${extension} installer for ${target}, found ${matches.length}`,
      );
    }
    return {
      source: matches[0],
      filename: `nightfall-v${version}-${target}${extension}`,
    };
  });
}

/** Reads the application version used by Tauri and the frontend build. */
function appVersion() {
  return JSON.parse(readFileSync("crates/app/tauri.conf.json", "utf8")).version;
}

/** Exposes validated release policy and the shared platform matrix to GitHub Actions. */
function prepareDesktopBuild() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version=1", "--no-deps"], {
      encoding: "utf8",
    }),
  );
  const crateVersion = metadata.packages.find(
    (pkg) => pkg.name === "nightfall-app",
  )?.version;
  const policy = desktopReleasePolicy(
    appVersion(),
    crateVersion,
    process.env.GITHUB_EVENT_NAME ?? "",
    process.env.GITHUB_REF ?? "",
  );
  const outputs = {
    ...policy,
    matrix: JSON.stringify({ include: desktopTargets }),
  };
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(outputs))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

/** Copies only complete installer sets into the flat workflow-artifact directory. */
function stageDesktopBuild() {
  const notices = JSON.parse(
    readFileSync(join("webui/dist/notices", noticesJson), "utf8"),
  );
  if (notices.distribution !== `Desktop — ${process.env.DESKTOP_TARGET}`) {
    throw new Error("Desktop notices do not match the installer target");
  }
  const plan = desktopArtifactPlan(
    process.env.DESKTOP_TARGET,
    appVersion(),
    JSON.parse(process.env.TAURI_ARTIFACT_PATHS ?? "[]"),
  );
  for (const artifact of plan) {
    if (!statSync(artifact.source).isFile())
      throw new Error(`Installer is not a file: ${artifact.source}`);
  }
  mkdirSync("desktop-artifacts", { recursive: true });
  for (const artifact of plan)
    copyFileSync(artifact.source, join("desktop-artifacts", artifact.filename));
  copyFileSync(
    join("webui/dist/notices", noticesText),
    join(
      "desktop-artifacts",
      `nightfall-v${appVersion()}-${process.env.DESKTOP_TARGET}-THIRD-PARTY-NOTICES.txt`,
    ),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv[2] === "prepare") prepareDesktopBuild();
  else if (process.argv[2] === "stage") stageDesktopBuild();
  else
    throw new Error("Usage: node scripts/desktop-artifacts.mjs prepare|stage");
}
