// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const loaderUrl = new URL("./node-test-extension-loader.mjs", import.meta.url);

/** Verifies emitted JSX can be imported from the test runner's temporary directory. */
test("loads compiled JSX through relative file, directory, and explicit imports", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "nightfall-loader-test-"));
  try {
    await mkdir(path.join(outDir, "nested"));
    const componentSource = `
      /** Provides JSX syntax that must be transformed before Node can load it. */
      export function Icon() { return <svg aria-hidden="true" />; }
    `;
    await writeFile(path.join(outDir, "icon.jsx"), componentSource);
    await writeFile(path.join(outDir, "nested", "index.jsx"), componentSource);
    await writeFile(
      path.join(outDir, "entry.mjs"),
      `
        import assert from "node:assert/strict";
        import { Icon as fileIcon } from "./icon";
        import { Icon as directoryIcon } from "./nested";
        import { Icon as explicitIcon } from "./icon.jsx";
        assert.equal(typeof fileIcon, "function");
        assert.equal(typeof directoryIcon, "function");
        assert.equal(explicitIcon, fileIcon);
      `,
    );

    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--loader", loaderUrl.href, "entry.mjs"],
      {
        cwd: outDir,
        env: { ...process.env, NIGHTFALL_REPO_ROOT: repoRoot },
        encoding: "utf8",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
