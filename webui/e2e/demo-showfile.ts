// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

/** Path of the gzip-compressed demo showfile beneath the deployed application base. */
export const DEMO_SHOWFILE_PATH =
  "nightfall-demo.nightfall-show/showfile.json.gz";

/** Route glob matching every request for the bundled demo showfile. */
export const DEMO_SHOWFILE_ROUTE = `**/${DEMO_SHOWFILE_PATH}`;

/**
 * Parse demo showfile bytes, inflating them only when they still carry the
 * gzip header (a host may already have decoded a `Content-Encoding: gzip` body).
 */
export function parseDemoShowfile(bytes: Buffer): any {
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return JSON.parse((isGzip ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/** Read and parse the demo showfile checked into the web UI's public assets. */
export async function readCheckedInDemoShowfile(): Promise<any> {
  return parseDemoShowfile(
    await readFile(new URL(`../public/${DEMO_SHOWFILE_PATH}`, import.meta.url)),
  );
}
