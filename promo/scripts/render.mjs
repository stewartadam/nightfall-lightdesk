// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import {
  browserExecutable,
  outDir,
  promoDir,
  reelArgument,
  renderWorkers,
  requireRecording,
} from "./common.mjs";

/**
 * Renders `out/<reel>.mp4` from the reel's latest take: bundles the Remotion
 * project with webpack, then renders frames in parallel headless tabs and
 * encodes them with Remotion's bundled ffmpeg.
 */
async function main() {
  const reel = reelArgument();
  requireRecording(reel);
  const started = performance.now();
  const serveUrl = await bundle({
    entryPoint: join(promoDir, "remotion", "index.ts"),
    publicDir: outDir,
  });
  const composition = await selectComposition({
    serveUrl,
    id: reel,
    browserExecutable: browserExecutable(),
  });
  const output = join(outDir, `${reel}.mp4`);
  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    // x264's default quality.
    crf: 23,
    concurrency: renderWorkers(),
    outputLocation: output,
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: "swangle" },
    onProgress: ({ progress }) => {
      const percent = Math.floor(progress * 10) * 10;
      if (percent !== lastLogged) {
        lastLogged = percent;
        process.stdout.write(`${reel}: ${percent}%\n`);
      }
    },
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`${reel}: rendered in ${seconds} s -> ${output}`);
}

await main();
