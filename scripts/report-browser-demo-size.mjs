// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const artifactDirectory = resolve("webui/dist");
const assetsDirectory = resolve("webui/dist/assets");
const showfilePath = resolve(
  artifactDirectory,
  "nightfall-demo.nightfall-show/showfile.json",
);

/** Return emitted files matching one browser-demo artifact expression. */
function matchingAssets(expression) {
  return readdirSync(assetsDirectory)
    .filter((name) => expression.test(name))
    .map((name) => resolve(assetsDirectory, name));
}

/** Measure packaged byte counts for one emitted artifact group. */
function measure(files) {
  let rawBytes = 0;
  for (const file of files) {
    rawBytes += statSync(file).size;
  }
  return {
    files: files.map((file) => basename(file)),
    rawBytes,
  };
}

/** Return the deployed files referenced by timeline audio paths in one showfile. */
function showfileTimelineAudioFiles(path) {
  const showfile = JSON.parse(readFileSync(path, "utf8"));
  const audioPaths = (showfile.timelines ?? [])
    .map((timeline) => timeline.audio_path)
    .filter((audioPath) => typeof audioPath === "string" && audioPath);
  return [...new Set(audioPaths)].map((audioPath) =>
    resolve(dirname(path), audioPath),
  );
}

/** Print deterministic release-size evidence for the browser-demo runtime. */
function main() {
  const groups = {
    engineWasm: measure(
      matchingAssets(/^nightfall_browser_runtime_bg-.*\.wasm$/),
    ),
    engineGlue: measure(matchingAssets(/^nightfall_browser_runtime-.*\.js$/)),
    worker: measure(matchingAssets(/^engine-runtime-worker-.*\.js$/)),
    sampleAudio: measure(showfileTimelineAudioFiles(showfilePath)),
    demoCode: measure(matchingAssets(/\.(?:css|js|wasm)$/)),
  };
  const total = {
    rawBytes: groups.demoCode.rawBytes + groups.sampleAudio.rawBytes,
  };
  process.stdout.write(`${JSON.stringify({ groups, total }, null, 2)}\n`);
}

main();
