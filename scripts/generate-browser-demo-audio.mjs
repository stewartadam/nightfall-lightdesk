// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSampleWav } from "./browser-demo-audio.mjs";

const showfilePath = resolve(
  "webui/public/nightfall-demo.nightfall-show/showfile.json",
);
const showfile = JSON.parse(readFileSync(showfilePath, "utf8"));
const audioPath = showfile.timelines?.[0]?.audio_path;
if (typeof audioPath !== "string" || !audioPath) {
  throw new Error("Browser demo showfile does not reference timeline audio");
}
const outputPath = resolve(dirname(showfilePath), audioPath);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, createSampleWav());
process.stdout.write(`${outputPath}\n`);
