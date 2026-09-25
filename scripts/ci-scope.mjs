// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sharedPackaging = [
  /^Cargo\.(toml|lock)$/,
  /^package(-lock)?\.json$/,
  /^rust-toolchain\.toml$/,
  /^\.cargo\//,
  /^vite\.config\.ts$/,
  /^about\.toml$/,
  /^config\/(notices\/|project-links\.json$)/,
  /^scripts\/.*notices/,
  /^scripts\/(package-sample-audio|check-distribution-wasm)/,
  /^scripts\/ci-scope/,
  /^\.github\/workflows\/(ci-precommit|wasm)\.yml$/,
  /^\.github\/actions\/wasm-assets\//,
  /^crates\/wasm-bridge\//,
  /^crates\/app-runtime\/assets\//,
  /^webui\/(index\.html$|public\/|lib\/engine-runtime|lib\/runtime-config\.ts$)/,
];
const desktopPackaging = [
  /^crates\/app-tauri\/(Cargo\.toml$|build\.rs$|tauri.*\.json$|capabilities\/|icons\/)/,
  /^crates\/app-runtime\/Cargo\.toml$/,
  /^scripts\/desktop-artifacts/,
  /^\.github\/workflows\/(desktop-artifacts|desktop-check|release)\.yml$/,
];
const desktopChecks = [
  /^crates\/app-tauri\/src\//,
  /^crates\/app-tauri\/tests\//,
  /^crates\/app-runtime\/src\/(lib|main|logging|runtime_config|session|shutdown|diagnostic_bundle|diagnostic_logs|diagnostic_showfile)\.rs$/,
  /^crates\/config\//,
];
const browserPackaging = [
  /^crates\/browser-runtime\//,
  /^scripts\/.*browser-demo/,
  /^\.github\/workflows\/browser-demo\.yml$/,
];

/** Select validation by integration risk; packaging jobs already include desktop compilation. */
export function selectScope({ event, ref, paths = [], distribution = "all" }) {
  let desktopPackage = false;
  let browserPackage = false;
  let desktopCheck = false;
  if (event === "workflow_dispatch") {
    if (!["all", "desktop", "browser"].includes(distribution)) {
      throw new Error(`Unknown distribution: ${distribution}`);
    }
    desktopPackage = distribution !== "browser";
    browserPackage = distribution !== "desktop";
  } else if (event === "push") {
    desktopPackage = ref === "refs/heads/main" || ref.startsWith("refs/tags/v");
    browserPackage = ref === "refs/heads/main";
  } else if (event === "pull_request") {
    for (const path of paths) {
      if (sharedPackaging.some((pattern) => pattern.test(path))) {
        desktopPackage = true;
        browserPackage = true;
      }
      if (desktopPackaging.some((pattern) => pattern.test(path)))
        desktopPackage = true;
      if (browserPackaging.some((pattern) => pattern.test(path)))
        browserPackage = true;
      if (desktopChecks.some((pattern) => pattern.test(path)))
        desktopCheck = true;
    }
  } else {
    throw new Error(`Unsupported CI event: ${event}`);
  }
  return {
    desktop_check: desktopCheck && !desktopPackage,
    desktop_package: desktopPackage,
    browser_package: browserPackage,
  };
}

/** Read the NUL-delimited PR diff captured by the credentialed source-acquisition job. */
export function readChangedPaths(contents) {
  return contents.split("\0").filter(Boolean);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const scope = selectScope({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    distribution: process.env.DISTRIBUTION || "all",
    paths: readChangedPaths(readFileSync(".ci-changed-files", "utf8")),
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(scope)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
