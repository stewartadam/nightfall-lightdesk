// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assessMergeRisk, limits, readFileEntries } from "./merge-policy.mjs";

/** Build a file entry shaped like the GitHub pull request files API returns. */
const file = (filename, lines = 10, extra = {}) => ({
  filename,
  additions: lines,
  deletions: 0,
  ...extra,
});

/** Small PRs confined to ordinary UI, engine, test and docs paths can go to the Claude review. */
test("small PRs outside risky areas are eligible", () => {
  for (const path of [
    "webui/components/Button.tsx",
    "webui/e2e/clip-go.spec.ts",
    "crates/clips/src/lib.rs",
    "crates/input_sacn/src/lib.rs",
    "crates/output_artnet/src/service.rs",
    "docs/src/user-guide/busking.md",
    "playwright/tests/clip-go-button.spec.ts",
    "README.md",
  ]) {
    assert.deepEqual(
      assessMergeRisk([file(path)]),
      { eligible: true, reasons: [], files: 1, lines: 10 },
      path,
    );
  }
});

/** Every risky area forces a human review, named after the area it touches. */
test("risky paths always need a human", () => {
  for (const [path, area] of [
    [".github/workflows/ci.yml", "CI"],
    [".github/claude-review.md", "CI"],
    ["scripts/ci-scope.mjs", "CI"],
    ["scripts/merge-policy.mjs", "CI"],
    ["scripts/release-notes.mjs", "CI"],
    [".pre-commit-config.yaml", "CI"],
    [".config/nextest.toml", "CI"],
    ["playwright.config.ts", "test tooling"],
    ["playwright/docs.config.ts", "test tooling"],
    ["biome.jsonc", "build"],
    ["tsconfig.app.json", "build"],
    ["Cargo.toml", "dependencies"],
    ["crates/clips/Cargo.toml", "dependencies"],
    ["Cargo.lock", "dependencies"],
    ["package.json", "dependencies"],
    ["pnpm-lock.yaml", "dependencies"],
    ["rust-toolchain.toml", "toolchain"],
    ["config/cargo-tools.json", "toolchain"],
    ["patches/three.patch", "dependencies"],
    ["crates/workspace-hack/src/lib.rs", "dependencies"],
    ["crates/showfile/src/migrations.rs", "showfile"],
    ["crates/websocket/src/lib.rs", "protocol"],
    ["desktop/app-tauri/tauri.conf.json", "desktop"],
    ["about.toml", "licensing"],
    ["CLAUDE.md", "agent instructions"],
    ["webui/components/CLAUDE.md", "agent instructions"],
    ["webui/CLAUDE.local.md", "agent instructions"],
    [".claude/settings.json", "agent instructions"],
    ["webui/.claude/settings.json", "agent instructions"],
    [".gitattributes", "LFS"],
  ]) {
    const result = assessMergeRisk([file(path)]);
    assert.equal(result.eligible, false, path);
    assert.equal(result.reasons.length, 1, path);
    assert.match(result.reasons[0], new RegExp(area), path);
    assert.match(
      result.reasons[0],
      new RegExp(`\`${path.replace(/\./g, "\\.")}\``),
      path,
    );
  }
});

/** Renaming a file out of a risky area still counts as touching that area. */
test("renames are judged by both their old and new paths", () => {
  const result = assessMergeRisk([
    file("crates/clips/src/format.rs", 0, {
      previous_filename: "crates/showfile/src/format.rs",
    }),
  ]);
  assert.equal(result.eligible, false);
  assert.match(result.reasons[0], /showfile/);
});

/** Added or modified files without line counts are binary, which neither check can measure. */
test("binary changes need a human", () => {
  const result = assessMergeRisk([
    file("webui/public/logo.png", 0, { status: "added" }),
  ]);
  assert.deepEqual(result.reasons, [
    "Changes binary files: `webui/public/logo.png`.",
  ]);
  assert.equal(
    assessMergeRisk([
      file("webui/components/B.tsx", 0, {
        status: "renamed",
        previous_filename: "webui/components/A.tsx",
      }),
    ]).eligible,
    true,
  );
});

/** PRs above either size limit need a human, and the reason states the measured size. */
test("large PRs need a human", () => {
  const tooManyFiles = Array.from({ length: limits.files + 1 }, (_, index) =>
    file(`webui/components/C${index}.tsx`, 1),
  );
  assert.deepEqual(assessMergeRisk(tooManyFiles).reasons, [
    `Changes ${limits.files + 1} files; auto-merge allows at most ${limits.files}.`,
  ]);

  const tooManyLines = [
    file("webui/components/A.tsx", limits.lines, { deletions: 1 }),
  ];
  assert.deepEqual(assessMergeRisk(tooManyLines).reasons, [
    `Changes ${limits.lines + 1} lines; auto-merge allows at most ${limits.lines}.`,
  ]);

  assert.equal(
    assessMergeRisk([file("webui/components/A.tsx", limits.lines)]).eligible,
    true,
  );
});

/** Long lists of risky paths are summarized so the verdict comment stays short. */
test("reasons list at most three paths per area", () => {
  const result = assessMergeRisk([
    file("crates/showfile/src/a.rs"),
    file("crates/showfile/src/b.rs"),
    file("crates/showfile/src/c.rs"),
    file("crates/showfile/src/d.rs"),
    file("crates/showfile/src/e.rs"),
  ]);
  assert.match(
    result.reasons[0],
    /`crates\/showfile\/src\/c\.rs` and 2 more\.$/,
  );
});

/** A PR with no file changes has nothing to review, so it is not cleared for auto-merge. */
test("empty PRs need a human", () => {
  assert.equal(assessMergeRisk([]).eligible, false);
});

/** The metadata snapshot is one JSON object per line, with blank lines ignored. */
test("file entries parse from newline-delimited JSON", () => {
  assert.deepEqual(
    readFileEntries(
      '{"filename":"a","additions":1,"deletions":2}\n\n{"filename":"b"}\n',
    ),
    [{ filename: "a", additions: 1, deletions: 2 }, { filename: "b" }],
  );
});
