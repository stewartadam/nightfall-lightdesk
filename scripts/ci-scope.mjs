// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
  /^scripts\/(package-sample-audio|check-distribution-wasm|cargo-tools\.mjs$)/,
  /^\.github\/actions\/cargo-tools\//,
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
  /^\.github\/actions\/(rust-cache|cargo-tools)\//,
  // Files outside crates/ that Rust code embeds with include_str! or include_bytes!.
  /^webui\/public\/nightfall-demo\.nightfall-show\//,
  /^webui\/assets\/models\/beat-this\/NOTICE\.md$/,
  /^config\/(project-links|beat-this-model)\.json$/,
];
const documentation = [
  /^docs\//,
  /^\.github\/actions\/cargo-tools\//,
  /^scripts\/ci-scope/,
  /^\.github\/workflows\/ci\.yml$/,
];
// Paths no WASM, native, WebUI or product-flow job reads: the manual, contributor prose, agent
// and editor configuration, repository metadata, workflows outside PR validation, script tests,
// and developer scripts that no build or test step executes. Every other path is an app input,
// so a new file is validated in full until it is listed here.
export const appIndependent = [
  /^docs\//,
  /^playwright\/(docs\.config\.ts|tests\/docs-[^/]+\.spec\.ts)$/,
  /^(AGENTS|CLAUDE|CONTRIBUTING|README)\.md$/,
  /^\.(agents|claude|vscode)\//,
  /^\.github\/(ISSUE_TEMPLATE\/|(copilot-instructions|desktop-release-notes|pull_request_template)\.md$|dependabot\.yml$)/,
  /^\.github\/workflows\/(README\.md|(desktop-updates|playwright-full|pr-commands|release-notes)\.yml)$/,
  /^scripts\/(?!ci-scope)[^/]+\.node\.test\.mjs$/,
  /^scripts\/(check-commit-signoff|claude-worktree-hook|fetch-gdtf-bench|generate-app-icons|install-fx-module|release-notes|seed-data-dir-from-main)\.mjs$/,
  /^scripts\/(profile-perf|test-desktop-updater|update-deps|verify_showfile_roundtrip)\.sh$/,
];

/** The manifest that pins the Cargo tools local setup and CI install. */
export const cargoToolsManifest = "config/cargo-tools.json";
// What each pinned Cargo tool validates when its version changes. A tool missing here, or a
// manifest change selection can't compare, validates everything.
const cargoToolScopes = {
  mdbook: ["docs"],
  "cargo-nextest": ["rust"],
  "cargo-hakari": ["rust"],
  "typeshare-cli": ["app"],
  "cargo-about": ["app", "packaging"],
};

/**
 * Name the tools whose pins differ between two revisions of the Cargo tools manifest, including
 * tools added or removed.
 */
export function changedCargoTools(base, head) {
  const before = JSON.parse(base);
  const after = JSON.parse(head);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort();
}

/**
 * Reduce a Cargo.lock to the parts that can change a distribution: every external package
 * entry, each workspace package's version, and the external packages each workspace package
 * reaches through other workspace packages. Which workspace package supplies an external
 * package is dropped, so rewiring that brings no new external package into any workspace
 * package's graph reduces to the same inputs. Packages without a `source` (workspace members
 * and path dependencies alike) count as workspace packages.
 */
export function lockfileDistributionInputs(contents) {
  const [header, ...entries] = contents.split(/^\[\[package\]\]\n/m);
  const packages = entries.map((entry) => {
    /** Read one `key = "value"` field from this package entry. */
    const field = (key) =>
      entry.match(new RegExp(`^${key} = "([^"]*)"$`, "m"))?.[1];
    return {
      entry,
      id: `${field("name")} ${field("version")}`,
      member: field("source") === undefined,
      dependencies: [...entry.matchAll(/^ "([^"]+)",$/gm)].map(
        ([, dependency]) => dependency,
      ),
    };
  });
  // Cargo writes a dependency as `name` when the name is unique in the lockfile, and as
  // `name version` or `name version (source)` otherwise, so both spellings resolve here and a
  // same-named external package never does.
  const workspace = new Map();
  for (const pkg of packages.filter(({ member }) => member)) {
    workspace.set(pkg.id, pkg);
    workspace.set(pkg.id.split(" ")[0], pkg);
  }
  const reached = new Map(
    [...workspace.values()].map((pkg) => [
      pkg,
      new Set(pkg.dependencies.filter((name) => !workspace.has(name))),
    ]),
  );
  // Dev-dependencies can form cycles between workspace packages, so propagate to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pkg, externals] of reached) {
      for (const name of pkg.dependencies) {
        for (const external of reached.get(workspace.get(name)) ?? []) {
          if (!externals.has(external)) {
            externals.add(external);
            changed = true;
          }
        }
      }
    }
  }
  const reduced = packages.map((pkg) =>
    pkg.member
      ? `${pkg.id}\n${[...reached.get(pkg)].sort().join("\n")}\n`
      : pkg.entry,
  );
  return [header, ...reduced].join("[[package]]\n");
}

/**
 * Whether two Cargo.lock revisions differ only in how workspace packages depend on each other,
 * without bringing a new external package into any workspace package's graph.
 */
export function lockfileChangesOnlyWorkspaceEdges(base, head) {
  return lockfileDistributionInputs(base) === lockfileDistributionInputs(head);
}

/**
 * Select validation by integration risk. Packaging compiles the desktop app but does not run
 * its tests, so desktop code or build-configuration changes select the desktop check even when
 * packaging also runs; shared inputs such as the lockfile rely on packaging alone. A lockfile
 * change that only rewires workspace packages (`workspaceOnlyLockfile`) is left to the Rust
 * tests, because no workspace package compiles a different set of external packages.
 *
 * The WASM packages, native backend, WebUI checks and Chromium product flows (`app`) run for every
 * push and manual run, but only for PRs that change an app input: any path outside
 * `appIndependent`. Rust tests always imply `app`, because the native job runs them.
 *
 * Browser previews build the demo for every same-repository PR that changes an app input or the
 * manual, once a preview target is configured. Fork PRs never receive the deployment credential,
 * so they never select one.
 *
 * Draft PRs select only their preview, under the same path rule, and reach selection only when
 * opened: the workflow skips source acquisition for later draft pushes, so CI validates nothing
 * until the PR is marked ready for review. The `/republish` PR command refreshes a draft's preview through a manual run
 * whose preview PR number likewise selects only that PR's preview.
 *
 * Documentation builds only for PRs that touch the mdBook sources or the workflow that builds them.
 * A preview whose PR touches them also publishes the built books beside the demo, including on
 * draft and manual preview runs, which otherwise build nothing but the demo.
 *
 * A change to the Cargo tools manifest validates what the changed pins affect (`cargoTools`):
 * mdBook selects the documentation build, nextest and hakari the Rust tests, typeshare the app,
 * and cargo-about the app and packaging. Without a base manifest to compare, every scope runs.
 *
 * Rust tests, doctests and Clippy run for every push and manual run, but only for PRs that touch
 * Rust sources, their build and lint configuration, or files the Rust code embeds. Native
 * validation still builds the headless backend whenever `app` is selected because the Chromium
 * product flows run against it.
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
  workspaceOnlyLockfile = false,
  cargoTools = null,
}) {
  const tools = paths.includes(cargoToolsManifest) ? (cargoTools ?? ["*"]) : [];
  /** Whether a changed tool pin validates the given scope. */
  const toolsTouch = (scope) =>
    tools.some((name) => cargoToolScopes[name]?.includes(scope) ?? true);
  const filePaths = paths.filter((path) => path !== cargoToolsManifest);
  /** Whether any changed path or tool pin is an mdBook input. */
  const touchesDocumentation = () =>
    toolsTouch("docs") ||
    filePaths.some((path) =>
      documentation.some((pattern) => pattern.test(path)),
    );
  /** Whether any changed path or tool pin can change what the app builds or runs. */
  const touchesApp = () =>
    toolsTouch("app") ||
    filePaths.some(
      (path) => !appIndependent.some((pattern) => pattern.test(path)),
    );
  /**
   * Select nothing but the given PR's preview, when a preview target can receive it, plus the
   * documentation build that preview publishes when the PR changes the books.
   */
  const previewOnly = (enabled, pr) => ({
    desktop_check: false,
    desktop_package: false,
    browser_package: false,
    browser_preview: enabled,
    preview_pr: enabled ? pr : "",
    docs: enabled && touchesDocumentation(),
    rust: false,
    app: false,
  });
  if (event === "workflow_dispatch" && previewPr) {
    if (!/^[1-9][0-9]*$/.test(previewPr)) {
      throw new Error(`Invalid preview PR number: ${previewPr}`);
    }
    return previewOnly(previewTarget, previewPr);
  }
  if (event === "pull_request" && draft) {
    return previewOnly(
      previewTarget &&
        sameRepository &&
        (touchesApp() || touchesDocumentation()),
      pullRequest,
    );
  }
  let desktopPackage = false;
  let browserPackage = false;
  let browserPreview = false;
  let desktopCheck = false;
  let docs = false;
  let rust = event !== "pull_request";
  let app = event !== "pull_request";
  if (event === "workflow_dispatch") {
    if (!["all", "desktop", "browser"].includes(distribution)) {
      throw new Error(`Unknown distribution: ${distribution}`);
    }
    desktopPackage = distribution !== "browser";
    browserPackage = distribution !== "desktop";
  } else if (event === "push") {
    // The release tag points at the main merge commit, so packaging main as well would build
    // the same installers twice; only the tag's build ships.
    desktopPackage = ref.startsWith("refs/tags/v");
    browserPackage = ref === "refs/heads/main";
  } else if (event === "pull_request") {
    app = touchesApp();
    docs = touchesDocumentation();
    browserPreview = previewTarget && sameRepository && (app || docs);
    rust = toolsTouch("rust");
    desktopPackage = browserPackage = toolsTouch("packaging");
    for (const path of filePaths) {
      const rewiresWorkspace = path === "Cargo.lock" && workspaceOnlyLockfile;
      if (
        !rewiresWorkspace &&
        sharedPackaging.some((pattern) => pattern.test(path))
      ) {
        desktopPackage = true;
        browserPackage = true;
      }
      if (desktopPackaging.some((pattern) => pattern.test(path)))
        desktopPackage = true;
      if (browserPackaging.some((pattern) => pattern.test(path)))
        browserPackage = true;
      if (desktopChecks.some((pattern) => pattern.test(path)))
        desktopCheck = true;
      if (rustTests.some((pattern) => pattern.test(path))) rust = true;
    }
    app ||= rust;
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
    app,
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
    workspaceOnlyLockfile:
      existsSync(".ci-base-Cargo.lock") &&
      existsSync("Cargo.lock") &&
      lockfileChangesOnlyWorkspaceEdges(
        readFileSync(".ci-base-Cargo.lock", "utf8"),
        readFileSync("Cargo.lock", "utf8"),
      ),
    cargoTools:
      existsSync(".ci-base-cargo-tools.json") && existsSync(cargoToolsManifest)
        ? changedCargoTools(
            readFileSync(".ci-base-cargo-tools.json", "utf8"),
            readFileSync(cargoToolsManifest, "utf8"),
          )
        : null,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(scope)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
