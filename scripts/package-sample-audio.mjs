// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceDirectory = fileURLToPath(
  new URL("../crates/app/assets/sample-audio/", import.meta.url),
);
const filenames = ["lofi.mp3", "rap.mp3"];

/** Validate all tracks before copying them beside a standalone backend executable. */
export function packageSampleAudio(destination, source = sourceDirectory) {
  for (const filename of filenames) {
    const bytes = readFileSync(join(source, filename));
    if (
      bytes.length === 0 ||
      bytes
        .subarray(0, 64)
        .toString()
        .startsWith("version https://git-lfs.github.com/spec/v1")
    ) {
      throw new Error(
        `${filename} is empty or an unresolved Git LFS pointer. Run git lfs pull before packaging.`,
      );
    }
  }
  if (destination) {
    const directory = join(destination, "sample-audio");
    mkdirSync(directory, { recursive: true });
    for (const filename of filenames) {
      copyFileSync(join(source, filename), join(directory, filename));
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error(
      "Usage: node scripts/package-sample-audio.mjs --check | <executable-directory>",
    );
  packageSampleAudio(
    destination === "--check" ? undefined : resolve(destination),
  );
}
