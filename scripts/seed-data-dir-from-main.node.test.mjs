// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nightfallTestDataDir } from "./nightfall-test-data-dir.mjs";
import {
  assertSafeReplacementTarget,
  parseCliOptions,
  seedDataDirectory,
  shouldCopySeedDataDirEntry,
} from "./seed-data-dir-from-main.mjs";

/**
 * Verifies that worktree data-dir seeding leaves root-level backups behind.
 */
test("seed data dir copy filter excludes only the root backups folder", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nightfall-seed-data-dir-"));
  const sourceDataDir = join(tempRoot, "source");
  const targetDataDir = join(tempRoot, "target");

  try {
    await mkdir(join(sourceDataDir, "backups", "default.nightfall-show"), {
      recursive: true,
    });
    await mkdir(join(sourceDataDir, "fixtures", "backups"), {
      recursive: true,
    });
    await writeFile(join(sourceDataDir, "fixtures", "profile.json"), "{}\n");
    await writeFile(
      join(sourceDataDir, "backups", "default.nightfall-show", "showfile.json"),
      "{}\n",
    );
    await writeFile(
      join(sourceDataDir, "fixtures", "backups", "note.txt"),
      "\n",
    );

    await cp(sourceDataDir, targetDataDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      mode: constants.COPYFILE_FICLONE,
      filter: (sourcePath) =>
        shouldCopySeedDataDirEntry(sourceDataDir, sourcePath),
    });

    assert.equal(
      shouldCopySeedDataDirEntry(sourceDataDir, join(sourceDataDir, "backups")),
      false,
    );
    assert.equal(
      shouldCopySeedDataDirEntry(
        sourceDataDir,
        join(sourceDataDir, "backups", "default.nightfall-show"),
      ),
      false,
    );
    assert.equal(
      shouldCopySeedDataDirEntry(
        sourceDataDir,
        join(sourceDataDir, "fixtures", "backups"),
      ),
      true,
    );

    await assert.rejects(
      () => cp(join(targetDataDir, "backups"), join(tempRoot, "probe")),
      { code: "ENOENT" },
    );
    await assert.doesNotReject(() =>
      cp(join(targetDataDir, "fixtures"), join(tempRoot, "fixtures-probe"), {
        recursive: true,
      }),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Verifies default seeding remains idempotent when target data already exists. */
test("default data-dir seeding preserves existing target contents", async () => {
  const tempRoot = await mkdtemp(
    join(tmpdir(), "nightfall-seed-skip-data-dir-"),
  );
  const sourceDataDir = join(tempRoot, "source");
  const targetDataDir = join(tempRoot, "target");

  try {
    await mkdir(sourceDataDir, { recursive: true });
    await mkdir(targetDataDir, { recursive: true });
    await writeFile(join(sourceDataDir, "new.json"), "new\n");
    await writeFile(join(targetDataDir, "existing.json"), "existing\n");

    const copied = await seedDataDirectory(sourceDataDir, targetDataDir);

    assert.equal(copied, false);
    await assert.doesNotReject(() =>
      stat(join(targetDataDir, "existing.json")),
    );
    await assert.rejects(() => stat(join(targetDataDir, "new.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Verifies forced seeding replaces stale contents with a clean source copy. */
test("forced data-dir seeding replaces existing target contents", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "nightfall-reseed-data-dir-"));
  const sourceDataDir = join(tempRoot, "source");
  const targetDataDir = join(tempRoot, "target");

  try {
    await mkdir(join(sourceDataDir, "fixtures"), { recursive: true });
    await mkdir(join(sourceDataDir, "backups"), { recursive: true });
    await mkdir(targetDataDir, { recursive: true });
    await writeFile(join(sourceDataDir, "fixtures", "profile.json"), "new\n");
    await writeFile(join(sourceDataDir, "backups", "ignored.txt"), "old\n");
    await writeFile(join(targetDataDir, "stale.json"), "stale\n");

    const copied = await seedDataDirectory(sourceDataDir, targetDataDir, {
      force: true,
    });

    assert.equal(copied, true);
    await assert.doesNotReject(() =>
      stat(join(targetDataDir, "fixtures", "profile.json")),
    );
    await assert.rejects(() => stat(join(targetDataDir, "stale.json")), {
      code: "ENOENT",
    });
    await assert.rejects(() => stat(join(targetDataDir, "backups")), {
      code: "ENOENT",
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Verifies forced replacement accepts only the generated worktree sandbox. */
test("forced data-dir seeding rejects targets outside its sandbox", () => {
  const projectRoot = "/repo/nightfall-worktrees/feature";
  assert.doesNotThrow(() =>
    assertSafeReplacementTarget(projectRoot, nightfallTestDataDir(projectRoot)),
  );
  assert.throws(
    () => assertSafeReplacementTarget(projectRoot, "/"),
    /Refusing to replace Nightfall data outside the worktree sandbox/u,
  );
  assert.throws(
    () => assertSafeReplacementTarget(projectRoot, "/Users/example/Documents"),
    /Refusing to replace Nightfall data outside the worktree sandbox/u,
  );
});

/** Verifies dashboard hook arguments select forced seeding for another worktree. */
test("seed data-dir CLI options select an explicit target worktree", () => {
  assert.deepEqual(
    parseCliOptions([
      "--force",
      "--project-root=/repo/nightfall-worktrees/feature",
    ]),
    {
      force: true,
      projectRoot: "/repo/nightfall-worktrees/feature",
    },
  );
  assert.deepEqual(parseCliOptions([]), {
    force: false,
    projectRoot: undefined,
  });
  assert.throws(
    () => parseCliOptions(["--project-root="]),
    /--project-root requires a path/u,
  );
});
