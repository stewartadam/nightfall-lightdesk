// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import {
  browserExecutable,
  outDir,
  reelArgument,
  reelsDir,
  renderWorkers,
  requireRecording,
} from "./common.mjs";

/** The app version from the workspace manifest, shown on every title card. */
function appVersion() {
  const manifest = readFileSync(join(reelsDir, "..", "Cargo.toml"), "utf8");
  const version = manifest.match(
    /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (!version) throw new Error("No [workspace.package] version in Cargo.toml");
  return version;
}

/**
 * Renders `out/<reel>.mp4` from the reel's latest take, plus
 * `out/<reel>-cover.png`, its title card, to upload as the cover where a
 * platform allows a custom one. Bundles the Remotion project with webpack,
 * then renders frames in parallel headless tabs and encodes them with
 * Remotion's bundled ffmpeg.
 */
async function main() {
  const reel = reelArgument();
  requireRecording(reel);
  const started = performance.now();
  const serveUrl = await bundle({
    entryPoint: join(reelsDir, "kit", "remotion", "index.ts"),
    publicDir: outDir,
  });
  const inputProps = { version: appVersion() };
  const composition = await selectComposition({
    serveUrl,
    id: reel,
    inputProps,
    browserExecutable: browserExecutable(),
  });
  // The title card is fully composed on the first frame.
  const cover = join(outDir, `${reel}-cover.png`);
  await renderStill({
    composition,
    serveUrl,
    inputProps,
    frame: 0,
    output: cover,
    browserExecutable: browserExecutable(),
  });
  const output = join(outDir, `${reel}.mp4`);
  let lastLogged = -1;
  await renderMedia({
    composition,
    serveUrl,
    inputProps,
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
  console.log(`${reel}: rendered in ${seconds} s -> ${output} and ${cover}`);
}

await main();
