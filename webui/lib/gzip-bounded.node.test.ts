// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { inflateGzipBounded } from "./gzip-bounded";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A gzip body inflates to the original bytes when it fits the limit. */
test("inflates a gzip body within the limit", async () => {
  const json = JSON.stringify({ fixtures: [1, 2, 3] });
  const unpacked = await inflateGzipBounded(gzipSync(json), 1024);
  assert.equal(decoder.decode(unpacked), json);
});

/** A small archive that expands past the limit is rejected while inflating. */
test("rejects a gzip body whose unpacked size exceeds the limit", async () => {
  const archive = gzipSync(Buffer.alloc(64 * 1024, 0x20));
  assert.ok(archive.byteLength < 1024);
  await assert.rejects(
    inflateGzipBounded(archive, 1024),
    /exceeds 1024 byte limit when unpacked/,
  );
});

/** A body the host already decoded passes through unchanged, still bounded by the limit. */
test("passes through a body without the gzip header", async () => {
  const body = encoder.encode('{"fixtures":[]}');
  assert.equal(await inflateGzipBounded(body, 1024), body);
  await assert.rejects(inflateGzipBounded(body, 4), /exceeds 4 byte limit/);
});

/** A truncated archive surfaces a decoding error instead of partial JSON. */
test("rejects a truncated gzip body", async () => {
  const archive = gzipSync("x".repeat(4096));
  await assert.rejects(
    inflateGzipBounded(archive.subarray(0, archive.byteLength - 8), 8192),
  );
});
