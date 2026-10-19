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
  /^package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^rust-toolchain\.toml$/,
  /^\.cargo\//,
  /^vite\.config\.ts$/,
  /^about\.toml$/,
  /^config\/(notices\/|project-links\.json$)/,
  /^scripts\/.*notices/,
  /^scripts\/(package-sample-audio|check-distribution-wasm)/,
  /^scripts\/ci-scope/,
  /^\.github\/workflows\/(ci|wasm)\.yml$/,
  /^\.github\/actions\/wasm-assets\//,
  /^crates\/wasm-bridge\//,
  /^crates\/app-runtime\/assets\//,
  /^webui\/(index\.html$|public\/|lib\/engine-runtime|lib\/runtime-config\.ts$)/,
];
const desktopPackaging = [
  /^desktop\/app-tauri\/(Cargo\.toml$|build\.rs$|tauri.*\.json$|capabilities\/|icons\/)/,
  /^crates\/app-runtime\/Cargo\.toml$/,
  /^scripts\/desktop-artifacts/,
  /^\.github\/workflows\/(desktop-artifacts|desktop-check|release)\.yml$/,
];
const desktopChecks = [
  /^desktop\/app-tauri\//,
  /^crates\/app-runtime\/Cargo\.toml$/,
  /^\.github\/workflows\/desktop-check\.yml$/,
  /^crates\/app-runtime\/src\/(lib|main|logging|runtime_config|session|shutdown|diagnostic_bundle|diagnostic_logs|diagnostic_showfile)\.rs$/,
  /^crates\/config\//,
];
const browserPackaging = [
  /^crates\/browser-runtime\//,
  /^scripts\/.*browser-demo/,
  /^\.github\/workflows\/browser-demo\.yml$/,
  /^webui\/e2e\/(browser-demo|distribution-notices)\.spec\.ts$/,
];
const rustTests = [
  /^crates\//,
  /^desktop\//,
  /^Cargo\.(toml|lock)$/,
  /^rust-toolchain\.toml$/,
  /^\.cargo\//,
  /^\.config\//,
  /^\.(clippy|rustfmt)\.toml$/,
  /^\.pre-commit-config\.yaml$/,
  /^scripts\/ci-scope/,
  /^\.github\/workflows\/(ci|native-validation)\.yml$/,
  /^\.github\/actions\/rust-cache\//,
  // Files outside crates/ that Rust code embeds with include_str! or include_bytes!.
  /^webui\/public\/nightfall-demo\.nightfall-show\//,
  /^webui\/assets\/models\/beat-this\/NOTICE\.md$/,
  /^config\/(project-links|beat-this-model)\.json$/,
];
const documentation = [
  /^docs\//,
  /^scripts\/ci-scope/,
  /^\.github\/workflows\/ci\.yml$/,
];

/**
 * Select validation by integration risk. Packaging compiles the desktop app but does not run
 * its tests, so desktop code or build-configuration changes select the desktop check even when
 * packaging also runs; shared inputs such as the lockfile rely on packaging alone.
 *
 * Browser previews build the demo for every same-repository PR once a preview target is
 * configured. Fork PRs never receive the deployment credential, so they never select one.
 *
 * Draft PRs select only their preview, and reach selection only when opened: the workflow skips
 * source acquisition for later draft pushes, so CI validates nothing until the PR is marked
 * ready for review. The `/republish` PR command refreshes a draft's preview through a manual run
 * whose preview PR number likewise selects only that PR's preview.
 *
 * Documentation builds only for PRs that touch the mdBook sources or the workflow that builds them.
 *
 * Rust tests, doctests and Clippy run for every push and manual run, but only for PRs that touch
 * Rust sources, their build and lint configuration, or files the Rust code embeds. Native
 * validation still builds the headless backend for every ready PR because the Chromium product flows
 * run against it.
 */
export function selectScope({
  event,
  ref,
  paths = [],
  distribution = "all",
  previewTarget = false,
  sameRepository = false,
  draft = false,
  pullRequest = "",
  previewPr = "",
}) {
  /** Select nothing but the given PR's preview, when a preview target can receive it. */
  const previewOnly = (enabled, pr) => ({
    desktop_check: false,
    desktop_package: false,
    browser_package: false,
    browser_preview: enabled,
    preview_pr: enabled ? pr : "",
    docs: false,
    rust: false,
  });
  if (event === "workflow_dispatch" && previewPr) {
    if (!/^[1-9][0-9]*$/.test(previewPr)) {
      throw new Error(`Invalid preview PR number: ${previewPr}`);
    }
    return previewOnly(previewTarget, previewPr);
  }
  if (event === "pull_request" && draft) {
    return previewOnly(previewTarget && sameRepository, pullRequest);
  }
  let desktopPackage = false;
  let browserPackage = false;
  let browserPreview = false;
  let desktopCheck = false;
  let docs = false;
  let rust = event !== "pull_request";
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
    browserPreview = previewTarget && sameRepository;
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
      if (documentation.some((pattern) => pattern.test(path))) docs = true;
      if (rustTests.some((pattern) => pattern.test(path))) rust = true;
    }
  } else {
    throw new Error(`Unsupported CI event: ${event}`);
  }
  return {
    desktop_check: desktopCheck,
    desktop_package: desktopPackage,
    browser_package: browserPackage,
    browser_preview: browserPreview,
    preview_pr: browserPreview ? pullRequest : "",
    docs,
    rust,
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
    previewTarget: Boolean(process.env.PREVIEW_WORKER),
    sameRepository:
      Boolean(process.env.HEAD_REPOSITORY) &&
      process.env.HEAD_REPOSITORY === process.env.GITHUB_REPOSITORY,
    draft: process.env.PR_DRAFT === "true",
    pullRequest: process.env.PR_NUMBER || "",
    previewPr: process.env.PREVIEW_PR || "",
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(scope)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
