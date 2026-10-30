// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultGdtfBenchDir, gdtfEnvironment } from "./gdtf-env.mjs";
import { missingInput } from "./run-gdtf-tests.mjs";

/** Verifies the bench cache follows each platform's cache convention. */
test("default bench dir uses the platform cache directory", () => {
  assert.equal(
    defaultGdtfBenchDir({ HOME: "/Users/me" }, "darwin"),
    join("/Users/me", "Library", "Caches", "nightfall", "gdtf-bench"),
  );
  assert.equal(
    defaultGdtfBenchDir({ HOME: "/home/me" }, "linux"),
    join("/home/me", ".cache", "nightfall", "gdtf-bench"),
  );
  assert.equal(
    defaultGdtfBenchDir({ HOME: "/home/me", XDG_CACHE_HOME: "/xdg" }, "linux"),
    join("/xdg", "nightfall", "gdtf-bench"),
  );
  assert.equal(
    defaultGdtfBenchDir(
      { USERPROFILE: "C:/me", LOCALAPPDATA: "C:/l" },
      "win32",
    ),
    join("C:/l", "nightfall", "gdtf-bench"),
  );
});

/** Verifies `.env` supplies GDTF keys beneath the shell and nothing else leaks through. */
test("worktree .env supplies GDTF settings beneath the shell", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gdtf-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, ".env"),
    [
      "NIGHTFALL_PORT=3000",
      "NIGHTFALL_DATA_DIR=data",
      "NIGHTFALL_GDTF_BENCH_DIR=bench",
      "GDTF_SHARE_USER=dotenv-user",
      'GDTF_SHARE_PASSWORD="dotenv-secret"',
    ].join("\n"),
  );

  const settings = await gdtfEnvironment(root, {
    HOME: "/home/me",
    GDTF_SHARE_USER: "shell-user",
  });

  assert.deepEqual(settings, {
    NIGHTFALL_GDTF_BENCH_DIR: join(root, "bench"),
    GDTF_SHARE_USER: "shell-user",
    GDTF_SHARE_PASSWORD: "dotenv-secret",
  });
});

/** Verifies an unset bench directory falls back to the per-user cache. */
test("bench dir defaults to the cache without .env", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gdtf-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: "/home/me", XDG_CACHE_HOME: "/xdg" };

  const settings = await gdtfEnvironment(root, env);

  assert.equal(settings.NIGHTFALL_GDTF_BENCH_DIR, defaultGdtfBenchDir(env));
});

/** Verifies the runner names what to do instead of letting Cargo panic. */
test("missing inputs explain the next step", () => {
  assert.match(
    missingInput("bench", { NIGHTFALL_GDTF_BENCH_DIR: "/nonexistent/bench" }),
    /pnpm run gdtf:fetch/,
  );
  assert.match(
    missingInput("corpus", { NIGHTFALL_GDTF_BENCH_DIR: tmpdir() }),
    /NIGHTFALL_GDTF_CORPUS_DIR/,
  );
  assert.equal(
    missingInput("corpus", {
      NIGHTFALL_GDTF_BENCH_DIR: "/nonexistent",
      NIGHTFALL_GDTF_CORPUS_DIR: "/corpus",
    }),
    undefined,
  );
});
