// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultMvrSamplesDir,
  fetchSamples,
  missingSamples,
  sampleUrl,
  sha256,
} from "./mvr-samples.mjs";

const source = {
  repository: "https://github.com/open-stage/python-mvr",
  commit: "abc123",
  path: "tests",
};

/** Builds a manifest pinning one sample to the hash of `contents`. */
function manifestFor(contents) {
  return {
    source,
    samples: [{ file: "demo show.mvr", sha256: sha256(Buffer.from(contents)) }],
  };
}

/** Returns a fetch stub that serves `contents` and records requested URLs. */
function fetchServing(contents, requests) {
  return async (url) => {
    requests.push(url);
    return new Response(contents);
  };
}

/** Sample URLs point at the pinned commit and encode spaces in file names. */
test("sampleUrl pins the commit and encodes the file name", () => {
  assert.equal(
    sampleUrl(source, { file: "demo show.mvr" }),
    "https://raw.githubusercontent.com/open-stage/python-mvr/abc123/tests/demo%20show.mvr",
  );
});

/** Samples are cached per user outside the repository on every platform. */
test("defaultMvrSamplesDir uses the per-user cache", () => {
  assert.equal(
    defaultMvrSamplesDir({ HOME: "/home/a" }, "linux"),
    "/home/a/.cache/nightfall/mvr-samples",
  );
  assert.equal(
    defaultMvrSamplesDir({ HOME: "/Users/a" }, "darwin"),
    "/Users/a/Library/Caches/nightfall/mvr-samples",
  );
});

/** A download is saved under its manifest name and skipped once it is present. */
test("fetchSamples downloads missing samples once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mvr-samples-"));
  try {
    const manifest = manifestFor("scene");
    const requests = [];
    const fetched = await fetchSamples(
      manifest,
      dir,
      fetchServing("scene", requests),
    );
    assert.deepEqual(fetched, ["demo show.mvr"]);
    assert.equal(readFileSync(join(dir, "demo show.mvr"), "utf8"), "scene");
    assert.deepEqual(missingSamples(manifest, dir), []);

    const again = await fetchSamples(
      manifest,
      dir,
      fetchServing("scene", requests),
    );
    assert.deepEqual(again, []);
    assert.equal(requests.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A file whose hash no longer matches the pin is refused and not saved. */
test("fetchSamples rejects a changed sample", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mvr-samples-"));
  try {
    const manifest = manifestFor("scene");
    writeFileSync(join(dir, "demo show.mvr"), "stale");
    assert.equal(missingSamples(manifest, dir).length, 1);
    await assert.rejects(
      fetchSamples(manifest, dir, fetchServing("tampered", [])),
      /has SHA-256/,
    );
    assert.equal(readFileSync(join(dir, "demo show.mvr"), "utf8"), "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
