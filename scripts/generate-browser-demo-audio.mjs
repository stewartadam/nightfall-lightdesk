// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { resolve } from "node:path";

import { writeTimelineAudio } from "./browser-demo-audio.mjs";

const written = writeTimelineAudio({
  showfilePath: resolve(
    "webui/public/nightfall-demo.nightfall-show/showfile.json",
  ),
  sampleAudioDir: resolve("crates/app/assets/sample-audio"),
});
for (const { path, source } of written) {
  process.stdout.write(`${path} (${source})\n`);
}
