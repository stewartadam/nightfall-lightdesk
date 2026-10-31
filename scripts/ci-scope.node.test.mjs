// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedCargoTools,
  lockfileChangesOnlyWorkspaceEdges,
  readChangedPaths,
  selectScope as selectFullScope,
} from "./ci-scope.mjs";

const none = {
  desktop_check: false,
  desktop_package: false,
  browser_package: false,
  browser_preview: false,
  preview_pr: "",
  docs: false,
};
const desktop = { ...none, desktop_package: true };
const browser = { ...none, browser_package: true };
const both = { ...desktop, browser_package: true };
const check = { ...none, desktop_check: true };
const desktopWithCheck = { ...desktop, desktop_check: true };

/**
 * Select scope without the Rust test, native and app validation decisions, which dedicated tests cover,
 * so the distribution tables stay focused on packaging and check ownership.
 */
function selectScope(options) {
  const {
    rust: _rust,
    native: _native,
    app: _app,
    ...scope
  } = selectFullScope(options);
  return scope;
}

/** Preserve the intended separation between runtime, shell, and distribution validation. */
test("PR selection follows distribution ownership", () => {
  for (const [path, expected] of [
    ["crates/app-runtime/src/systems/showfile_events/save.rs", none],
    ["crates/app-runtime/src/tests.rs", none],
    ["crates/app-runtime/src/sample_data/fixtures.rs", none],
    ["webui/components/example.tsx", none],
    ["desktop/app-tauri/src/desktop_shell.rs", check],
    ["crates/app-runtime/src/lib.rs", check],
    ["crates/app-runtime/src/session.rs", check],
    ["crates/app-runtime/src/shutdown.rs", check],
    ["crates/app-runtime/src/diagnostic_logs.rs", check],
    ["crates/config/src/lib.rs", check],
    ["desktop/app-tauri/tauri.conf.json", desktopWithCheck],
    ["desktop/app-tauri/capabilities/default.json", desktopWithCheck],
    ["desktop/app-tauri/icons/icon.ico", desktopWithCheck],
    ["desktop/app-tauri/build.rs", desktopWithCheck],
    ["desktop/app-tauri/Cargo.toml", desktopWithCheck],
    ["crates/app-runtime/Cargo.toml", desktopWithCheck],
    [".github/workflows/desktop-check.yml", desktopWithCheck],
    ["crates/browser-runtime/src/lib.rs", browser],
    ["scripts/browser-demo-audio.mjs", browser],
    [".github/workflows/browser-demo.yml", browser],
    ["webui/e2e/browser-demo.spec.ts", browser],
    ["webui/e2e/distribution-notices.spec.ts", browser],
    ["webui/e2e/browser-demo-soak.spec.ts", none],
    [".github/workflows/desktop-artifacts.yml", desktop],
    [".github/workflows/release-notes.yml", none],
    ["scripts/release-notes.mjs", none],
    ["Cargo.lock", both],
    ["Cargo.toml", both],
    ["pnpm-lock.yaml", both],
    ["pnpm-workspace.yaml", both],
    ["crates/app-runtime/assets/sample-audio/lofi.mp3", both],
    [".github/workflows/ci.yml", { ...both, docs: true }],
    ["scripts/ci-scope.mjs", { ...both, docs: true }],
    ["docs/src/SUMMARY.md", { ...none, docs: true }],
    ["docs/book.toml", { ...none, docs: true }],
    ["docs/theme/navigation.js", { ...none, docs: true }],
    ["CONTRIBUTING.md", none],
    ["README.md", none],
    ["crates/wasm-bridge/src/lib.rs", both],
  ]) {
    assert.deepEqual(
      selectScope({
        event: "pull_request",
        ref: "refs/pull/1/merge",
        paths: [path],
      }),
      expected,
      path,
    );
  }
});

/** Packaging does not run desktop tests, so desktop code keeps the check beside packaging. */
test("combined changes run each required validation once", () => {
  /** Apply PR selection to a combined change set. */
  const select = (paths) =>
    selectScope({ event: "pull_request", ref: "refs/pull/1/merge", paths });
  assert.deepEqual(
    select(["desktop/app-tauri/src/main.rs", "desktop/app-tauri/build.rs"]),
    desktopWithCheck,
  );
  assert.deepEqual(select(["desktop/app-tauri/src/main.rs", "Cargo.lock"]), {
    ...both,
    desktop_check: true,
  });
  assert.deepEqual(select(["Cargo.lock"]), both);
  assert.deepEqual(
    select([
      "desktop/app-tauri/src/main.rs",
      "crates/browser-runtime/src/lib.rs",
    ]),
    { ...check, browser_package: true },
  );
});

/**
 * Render a Cargo.lock from package descriptions the way Cargo writes it: registry packages carry
 * a source and checksum, and an empty dependency list omits the key.
 */
function lockfile(packages) {
  const entries = packages.map(
    ({ name, version = "0.1.0", external = false, dependencies = [] }) =>
      [
        "[[package]]",
        `name = "${name}"`,
        `version = "${version}"`,
        ...(external
          ? [
              'source = "registry+https://github.com/rust-lang/crates.io-index"',
              `checksum = "${"0".repeat(64)}"`,
            ]
          : []),
        ...(dependencies.length
          ? [
              "dependencies = [",
              ...dependencies.map((dependency) => ` "${dependency}",`),
              "]",
            ]
          : []),
      ].join("\n"),
  );
  return `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n${entries.join("\n\n")}\n`;
}

/**
 * Build a small workspace lockfile, merging `overrides` into the packages they name, so each
 * case states only what it changes from the base. A workspace `config` shares its name with a
 * registry package, so Cargo spells every edge to either with its version.
 */
function workspaceLockfile(overrides = {}) {
  const packages = {
    config: { name: "config", dependencies: ["serde"] },
    "config 0.14.0": { name: "config", version: "0.14.0", external: true },
    coremidi: { name: "coremidi", version: "0.8.0", external: true },
    nightfall: { name: "nightfall", dependencies: ["serde"] },
    "nightfall-engine": {
      name: "nightfall-engine",
      dependencies: ["config 0.1.0", "nightfall", "serde"],
    },
    "nightfall-input-midi": {
      name: "nightfall-input-midi",
      dependencies: ["coremidi"],
    },
    "nightfall-timecode": { name: "nightfall-timecode" },
    serde: { name: "serde", version: "1.0.0", external: true },
  };
  for (const [key, changes] of Object.entries(overrides)) {
    packages[key] = { ...packages[key], ...changes };
  }
  return lockfile(Object.values(packages));
}

/**
 * Workspace rewiring is ignored only while every workspace package keeps reaching the same
 * external packages; external entries and workspace versions always count.
 */
test("lockfile comparison separates workspace rewiring from dependency changes", () => {
  const base = workspaceLockfile();
  /** Replace the engine's dependency list. */
  const engineDependencies = (dependencies) =>
    workspaceLockfile({ "nightfall-engine": { dependencies } });
  for (const [name, head, expected] of [
    ["unchanged", workspaceLockfile(), true],
    [
      "workspace edge without new externals added",
      engineDependencies([
        "config 0.1.0",
        "nightfall",
        "nightfall-timecode",
        "serde",
      ]),
      true,
    ],
    [
      "versioned workspace edge added",
      engineDependencies([
        "config 0.1.0",
        "nightfall",
        "nightfall-timecode 0.1.0",
        "serde",
      ]),
      true,
    ],
    [
      "workspace edge removed while its externals stay reachable",
      engineDependencies(["config 0.1.0", "serde"]),
      true,
    ],
    [
      "workspace edge bringing in a new external",
      engineDependencies([
        "config 0.1.0",
        "nightfall",
        "nightfall-input-midi",
        "serde",
      ]),
      false,
    ],
    [
      "external edge added",
      workspaceLockfile({ "nightfall-timecode": { dependencies: ["serde"] } }),
      false,
    ],
    [
      "external sharing a workspace package's name added",
      engineDependencies([
        "config 0.1.0",
        "config 0.14.0",
        "nightfall",
        "serde",
      ]),
      false,
    ],
    [
      "dependency cycle reaching new externals",
      workspaceLockfile({
        "nightfall-timecode": { dependencies: ["nightfall-engine"] },
        "nightfall-engine": {
          dependencies: [
            "config 0.1.0",
            "nightfall",
            "nightfall-timecode",
            "serde",
          ],
        },
      }),
      false,
    ],
    [
      "external package upgraded",
      workspaceLockfile({ serde: { version: "1.0.1" } }),
      false,
    ],
    [
      "workspace version changed",
      workspaceLockfile({ nightfall: { version: "0.2.0" } }),
      false,
    ],
  ]) {
    assert.equal(lockfileChangesOnlyWorkspaceEdges(base, head), expected, name);
  }
});

/** A lockfile that only rewires workspace crates runs Rust tests but no packaging. */
test("workspace-only lockfile changes skip packaging", () => {
  /** Select a PR touching the given paths with the lockfile classified as workspace-only. */
  const select = (paths) =>
    selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths,
      workspaceOnlyLockfile: true,
    });
  assert.deepEqual(select(["Cargo.lock"]), {
    ...none,
    rust: true,
    native: true,
    app: true,
  });
  assert.deepEqual(select(["Cargo.lock", "Cargo.toml"]), {
    ...both,
    rust: true,
    native: true,
    app: true,
  });
  assert.deepEqual(select(["Cargo.lock", "crates/app-runtime/Cargo.toml"]), {
    ...desktopWithCheck,
    rust: true,
    native: true,
    app: true,
  });
});

/** Branch, release, and manual policies do not accidentally depend on a PR path filter. */
test("event policy packages desktop on release tags only, browser on main, with explicit manual choices", () => {
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/heads/main" }),
    browser,
  );
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/heads/develop" }),
    none,
  );
  assert.deepEqual(
    selectScope({ event: "push", ref: "refs/tags/v0.1.0" }),
    desktop,
  );
  for (const [distribution, expected] of [
    ["all", both],
    ["desktop", desktop],
    ["browser", browser],
  ]) {
    assert.deepEqual(
      selectScope({
        event: "workflow_dispatch",
        ref: "refs/heads/develop",
        distribution,
      }),
      expected,
    );
  }
  assert.throws(() =>
    selectScope({ event: "workflow_dispatch", distribution: "invalid" }),
  );
  assert.throws(() => selectScope({ event: "unknown", ref: "" }));
});

/** Previews build only for configured same-repository PRs, independently of packaging. */
test("browser previews require a configured target and a same-repository PR", () => {
  /** Select a UI-only PR with the given preview conditions. */
  const select = (options) =>
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["webui/components/example.tsx"],
      pullRequest: "1",
      ...options,
    });
  assert.deepEqual(select({ previewTarget: true, sameRepository: true }), {
    ...none,
    browser_preview: true,
    preview_pr: "1",
  });
  assert.deepEqual(
    select({ previewTarget: true, sameRepository: false }),
    none,
  );
  assert.deepEqual(
    select({ previewTarget: false, sameRepository: true }),
    none,
  );
  assert.deepEqual(
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["crates/browser-runtime/src/lib.rs"],
      pullRequest: "1",
      previewTarget: true,
      sameRepository: true,
    }),
    { ...browser, browser_preview: true, preview_pr: "1" },
  );
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(
      selectScope({ event, ref, previewTarget: true, sameRepository: true })
        .browser_preview,
      false,
      event,
    );
  }
});

/** A preview of an unchanged app is skipped, but manual changes still publish their books. */
test("browser previews follow app inputs and the manual", () => {
  /** Select a configured same-repository PR touching the given paths. */
  const select = (paths) =>
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths,
      pullRequest: "1",
      previewTarget: true,
      sameRepository: true,
    });
  assert.deepEqual(select(["scripts/update-deps.sh"]), none);
  assert.deepEqual(select(["README.md", "AGENTS.md"]), none);
  assert.deepEqual(select(["docs/src/SUMMARY.md"]), {
    ...none,
    browser_preview: true,
    preview_pr: "1",
    docs: true,
  });
});

/**
 * App validation (WASM packages, native backend, WebUI checks, Chromium product flows) runs for
 * PRs that change any path outside the app-independent list, and for every push and manual run.
 */
test("app validation runs only for PRs that can change the app", () => {
  /** Select a ready PR touching the given paths. */
  const select = (paths) =>
    selectFullScope({ event: "pull_request", ref: "refs/pull/1/merge", paths });
  for (const [path, expected] of [
    ["scripts/update-deps.sh", false],
    ["scripts/release-notes.mjs", false],
    ["scripts/run-playwright.node.test.mjs", false],
    ["docs/src/SUMMARY.md", false],
    ["README.md", false],
    ["CONTRIBUTING.md", false],
    [".agents/skills/beads/SKILL.md", false],
    [".claude/settings.json", false],
    [".github/pull_request_template.md", false],
    [".github/workflows/release-notes.yml", false],
    [".github/workflows/README.md", false],
    ["playwright/docs.config.ts", false],
    ["playwright/tests/docs-developer-guide.spec.ts", false],
    ["playwright/tests/clip-go-button.spec.ts", true],
    ["scripts/ci-scope.mjs", true],
    ["scripts/ci-scope.node.test.mjs", true],
    ["scripts/ci-scope-integration.node.test.mjs", true],
    ["scripts/run-playwright.mjs", true],
    ["scripts/build-wasm.mjs", true],
    ["scripts/a-new-tool.mjs", true],
    ["webui/components/example.tsx", true],
    ["webui/e2e/clip-go-button.spec.ts", true],
    ["playwright.config.ts", true],
    ["package.json", true],
    ["pnpm-lock.yaml", true],
    ["crates/engine/src/lib.rs", true],
    ["Cargo.lock", true],
    ["LICENSE", true],
    ["test-fixtures/showfile.json", true],
    [".github/workflows/ci.yml", true],
    [".github/workflows/native-validation.yml", true],
    [".github/actions/playwright-smoke/action.yml", true],
  ]) {
    assert.equal(select([path]).app, expected, path);
  }
  assert.equal(
    select(["scripts/update-deps.sh", "webui/components/example.tsx"]).app,
    true,
  );
  assert.equal(select([]).app, false);
  for (const [event, ref] of [
    ["push", "refs/heads/develop"],
    ["push", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(selectFullScope({ event, ref }).app, true, `${event} ${ref}`);
  }
});

/**
 * Worktree dashboard changes keep the WASM packages and WebUI checks that typecheck its page, but
 * skip the native backend and Chromium product flows, which never load it.
 */
test("dashboard-only PRs skip native validation and product flows", () => {
  /** Select a ready PR touching the given paths and report its app and native decisions. */
  const select = (paths) => {
    const scope = selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths,
    });
    return [scope.rust, scope.native, scope.app];
  };
  for (const path of [
    "worktree-dashboard/worktree-dashboard.mjs",
    "worktree-dashboard/a-new-module.mjs",
    "webui/worktree-dashboard.tsx",
    "webui/worktree-dashboard.html",
    "webui/e2e/worktree-dashboard.spec.ts",
  ]) {
    assert.deepEqual(select([path]), [false, false, true], path);
  }
  assert.deepEqual(
    select([
      "worktree-dashboard/dashboard-client.mjs",
      "webui/worktree-dashboard.tsx",
      "scripts/worktree-service.node.test.mjs",
      "CONTRIBUTING.md",
    ]),
    [false, false, true],
  );
  for (const path of [
    "webui/components/ui/table.tsx",
    "scripts/setup-env.mjs",
    "crates/engine/src/lib.rs",
  ]) {
    assert.deepEqual(
      select(["webui/worktree-dashboard.tsx", path])[1],
      true,
      path,
    );
  }
  for (const [event, ref] of [
    ["push", "refs/heads/develop"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(
      selectFullScope({ event, ref }).native,
      true,
      `${event} ${ref}`,
    );
  }
});

/** The native job runs the Rust tests, so every path that selects them also selects app validation. */
test("Rust test inputs always select app validation", () => {
  for (const path of [
    "crates/engine/src/lib.rs",
    "desktop/app-tauri/src/main.rs",
    ".config/nextest.toml",
    ".pre-commit-config.yaml",
    "webui/assets/models/beat-this/NOTICE.md",
    "config/project-links.json",
  ]) {
    const scope = selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: [path],
    });
    assert.deepEqual(
      [scope.rust, scope.native, scope.app],
      [true, true, true],
      path,
    );
  }
});

/** An opening draft PR builds only its preview, plus the books it publishes when it changes them. */
test("draft PRs select only their preview", () => {
  /** Select a draft PR touching every kind of input with the given preview conditions. */
  const select = (options) =>
    selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: [
        "Cargo.lock",
        "desktop/app-tauri/src/main.rs",
        "docs/src/SUMMARY.md",
      ],
      pullRequest: "1",
      draft: true,
      ...options,
    });
  assert.deepEqual(select({ previewTarget: true, sameRepository: true }), {
    ...none,
    browser_preview: true,
    preview_pr: "1",
    docs: true,
    rust: false,
    native: false,
    app: false,
  });
  assert.deepEqual(
    select({
      previewTarget: true,
      sameRepository: true,
      paths: ["Cargo.lock", "desktop/app-tauri/src/main.rs"],
    }),
    {
      ...none,
      browser_preview: true,
      preview_pr: "1",
      rust: false,
      native: false,
      app: false,
    },
  );
  assert.deepEqual(select({ previewTarget: true, sameRepository: false }), {
    ...none,
    rust: false,
    native: false,
    app: false,
  });
  assert.deepEqual(select({ previewTarget: false, sameRepository: true }), {
    ...none,
    rust: false,
    native: false,
    app: false,
  });
  assert.deepEqual(
    select({
      previewTarget: true,
      sameRepository: true,
      paths: ["scripts/update-deps.sh"],
    }),
    { ...none, rust: false, native: false, app: false },
  );
});

/** A manual run naming a PR builds only that PR's preview and its changed books, so `/republish` can serve drafts. */
test("manual preview runs select only the preview", () => {
  /** Select a manual preview run, which ignores the packaging choice it is dispatched with. */
  const select = (options) =>
    selectFullScope({
      event: "workflow_dispatch",
      ref: "refs/heads/feature",
      distribution: "all",
      previewPr: "42",
      ...options,
    });
  assert.deepEqual(select({ previewTarget: true }), {
    ...none,
    browser_preview: true,
    preview_pr: "42",
    rust: false,
    native: false,
    app: false,
  });
  assert.deepEqual(select({ previewTarget: false }), {
    ...none,
    rust: false,
    native: false,
    app: false,
  });
  assert.deepEqual(
    select({ previewTarget: true, paths: ["docs/src/SUMMARY.md"] }),
    {
      ...none,
      browser_preview: true,
      preview_pr: "42",
      docs: true,
      rust: false,
      native: false,
      app: false,
    },
  );
  assert.deepEqual(
    select({ previewTarget: false, paths: ["docs/src/SUMMARY.md"] }),
    { ...none, rust: false, native: false, app: false },
  );
  for (const previewPr of ["0", "4a", "-1", "1 2"]) {
    assert.throws(() => select({ previewTarget: true, previewPr }), previewPr);
  }
});

/** Documentation builds follow PR paths and never run for branch or manual events. */
test("documentation builds only for PRs that touch the manual", () => {
  assert.equal(
    selectScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["docs/src/user-guide/index.md"],
    }).docs,
    true,
  );
  for (const [event, ref] of [
    ["push", "refs/heads/main"],
    ["push", "refs/heads/develop"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(selectScope({ event, ref }).docs, false, `${event} ${ref}`);
  }
});

/** Pins compare by tool, so a docs-only tool bump validates only the docs. */
test("Cargo tool pins validate what the changed tools affect", () => {
  assert.deepEqual(
    changedCargoTools(
      '{"mdbook": "0.4.49", "cargo-nextest": "0.9.146"}',
      '{"mdbook": "0.5.4", "cargo-nextest": "0.9.146", "cargo-about": "0.8.4"}',
    ),
    ["cargo-about", "mdbook"],
  );
  /** Select a ready PR that changes the manifest and, optionally, other paths. */
  const select = (cargoTools, paths = []) =>
    selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["config/cargo-tools.json", ...paths],
      cargoTools,
    });
  const quiet = {
    desktop_check: false,
    desktop_package: false,
    browser_package: false,
    browser_preview: false,
    preview_pr: "",
    docs: false,
    rust: false,
    native: false,
    app: false,
  };
  assert.deepEqual(select(["mdbook"]), { ...quiet, docs: true });
  assert.deepEqual(select(["cargo-nextest"]), {
    ...quiet,
    rust: true,
    native: true,
    app: true,
  });
  assert.deepEqual(select(["typeshare-cli"]), {
    ...quiet,
    native: true,
    app: true,
  });
  assert.deepEqual(select(["cargo-about"]), {
    ...quiet,
    desktop_package: true,
    browser_package: true,
    native: true,
    app: true,
  });
  assert.deepEqual(select(["mdbook"], ["crates/engine/src/lib.rs"]), {
    ...quiet,
    docs: true,
    rust: true,
    native: true,
    app: true,
  });
  const unknown = {
    ...quiet,
    desktop_package: true,
    browser_package: true,
    docs: true,
    rust: true,
    native: true,
    app: true,
  };
  assert.deepEqual(select(null), unknown);
  assert.deepEqual(select(["a-new-tool"]), unknown);
});

/**
 * Rust tests follow Rust sources, build and lint configuration, and the non-crate files Rust
 * embeds, and always run for pushes and manual runs.
 */
test("Rust tests run only for PRs that can change Rust behavior", () => {
  for (const [path, expected] of [
    ["crates/engine/src/lib.rs", true],
    ["crates/app-runtime/tests/data/procedural-showfile-parse-data.json", true],
    ["desktop/app-tauri/src/main.rs", true],
    ["Cargo.lock", true],
    ["Cargo.toml", true],
    ["rust-toolchain.toml", true],
    [".cargo/config.toml", true],
    [".config/nextest.toml", true],
    [".config/hakari.toml", true],
    [".clippy.toml", true],
    [".rustfmt.toml", true],
    [".pre-commit-config.yaml", true],
    [".github/workflows/native-validation.yml", true],
    [".github/workflows/ci.yml", true],
    [".github/actions/rust-cache/action.yml", true],
    ["scripts/ci-scope.mjs", true],
    ["webui/public/nightfall-demo.nightfall-show/showfile.json.gz", true],
    ["webui/assets/models/beat-this/NOTICE.md", true],
    ["config/project-links.json", true],
    ["config/beat-this-model.json", true],
    ["webui/index.html", false],
    ["webui/components/example.tsx", false],
    ["webui/public/logo.svg", false],
    ["pnpm-lock.yaml", false],
    ["docs/src/SUMMARY.md", false],
    ["README.md", false],
  ]) {
    assert.equal(
      selectFullScope({
        event: "pull_request",
        ref: "refs/pull/1/merge",
        paths: [path],
      }).rust,
      expected,
      path,
    );
  }
  assert.equal(
    selectFullScope({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      paths: ["webui/index.html", "crates/engine/src/lib.rs"],
    }).rust,
    true,
  );
  for (const [event, ref] of [
    ["push", "refs/heads/develop"],
    ["push", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/develop"],
  ]) {
    assert.equal(selectFullScope({ event, ref }).rust, true, `${event} ${ref}`);
  }
});

/** NUL-delimited paths preserve unusual names without interpreting them as script or shell input. */
test("changed paths preserve whitespace and newlines", () => {
  assert.deepEqual(readChangedPaths("a b\0line\nbreak\0"), [
    "a b",
    "line\nbreak",
  ]);
  assert.deepEqual(readChangedPaths(""), []);
});
