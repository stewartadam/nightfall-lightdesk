// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageSampleAudio } from "./package-sample-audio.mjs";

/** Repackaging copies replacement tracks without changing a previously built executable. */
test("copies current external tracks beside an untouched executable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sample-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  mkdirSync(output);
  writeFileSync(join(output, "nightfall-app"), "unchanged executable");
  for (const name of ["lofi.mp3", "rap.mp3"])
    writeFileSync(join(source, name), `ID3 ${name}`);
  packageSampleAudio(output, source);
  writeFileSync(join(source, "lofi.mp3"), "ID3 replacement");
  packageSampleAudio(output, source);
  assert.equal(
    readFileSync(join(output, "sample-audio/lofi.mp3"), "utf8"),
    "ID3 replacement",
  );
  assert.equal(
    readFileSync(join(output, "sample-audio/rap.mp3"), "utf8"),
    "ID3 rap.mp3",
  );
  assert.equal(
    readFileSync(join(output, "nightfall-app"), "utf8"),
    "unchanged executable",
  );
});

/** Incomplete LFS checkouts fail before any destination files are installed. */
test("rejects missing, empty and pointer assets before copying", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sample-resources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output");
  writeFileSync(join(root, "lofi.mp3"), "ID3 audio");
  assert.throws(() => packageSampleAudio(output, root), /ENOENT/);
  for (const content of ["", "version https://git-lfs.github.com/spec/v1\n"]) {
    writeFileSync(join(root, "rap.mp3"), content);
    assert.throws(() => packageSampleAudio(output, root), /git lfs pull/);
    assert.equal(existsSync(output), false);
  }
});
