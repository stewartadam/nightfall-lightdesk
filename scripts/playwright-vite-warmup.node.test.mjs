// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  moduleImportUrls,
  warmViteModuleGraph,
  withWorkerLock,
} from "./playwright-vite-warmup.mjs";

/** Verify static, side-effect, re-export and literal dynamic imports are all found. */
test("module import URLs cover every root-relative import form", () => {
  const source = [
    'import { a } from "/lib/a.ts";',
    "import '/styles/b.css';",
    'export * from "/lib/c.ts";',
    'const panel = () => import("/features/d/panel.tsx");',
    'import dep from "/node_modules/.vite/deps/e.js?v=1234";',
    'import("./relative.ts"); import x from "bare";',
  ].join("\n");

  assert.deepEqual(moduleImportUrls(source).sort(), [
    "/features/d/panel.tsx",
    "/lib/a.ts",
    "/lib/c.ts",
    "/node_modules/.vite/deps/e.js?v=1234",
    "/styles/b.css",
  ]);
});

/** Verify module scripts in the HTML entry seed the crawl. */
test("module import URLs include HTML script sources", () => {
  assert.deepEqual(
    moduleImportUrls(
      '<script type="module" src="/@vite/client"></script><script type="module" src="/main.tsx"></script>',
    ),
    ["/@vite/client", "/main.tsx"],
  );
});

/** Verify the crawl requests every reachable module exactly once and skips failures. */
test("warming requests the whole reachable graph once", async () => {
  const modules = {
    "/": '<script type="module" src="/main.ts"></script>',
    "/main.ts": 'import "/a.ts"; const lazy = () => import("/b.ts");',
    "/a.ts": 'import "/b.ts"; import "/missing.ts";',
    "/b.ts": 'import "/a.ts";',
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const body = modules[request.url];
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const fetched = await warmViteModuleGraph(`http://127.0.0.1:${port}`, {
      concurrency: 2,
    });
    assert.equal(fetched, 4);
    assert.deepEqual(requests.sort(), [
      "/",
      "/a.ts",
      "/b.ts",
      "/main.ts",
      "/missing.ts",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Verify concurrent holders run one at a time and release the lock afterwards. */
test("worker lock serializes concurrent tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-vite-lock-"));
  try {
    const lockPath = join(root, "vite-startup.lock");
    const events = [];
    const task = (name) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([
      withWorkerLock(lockPath, task("a")),
      withWorkerLock(lockPath, task("b")),
    ]);
    assert.deepEqual(results, ["a", "b"]);
    assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
    assert.equal(await withWorkerLock(lockPath, async () => "free"), "free");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/** Verify a lock left behind by a dead holder only delays the task until the wait expires. */
test("worker lock runs the task after a stale lock times out", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightfall-vite-lock-"));
  try {
    const lockPath = join(root, "vite-startup.lock");
    await withWorkerLock(lockPath, async () => {
      assert.equal(
        await withWorkerLock(lockPath, async () => "ran", { waitMs: 200 }),
        "ran",
      );
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
