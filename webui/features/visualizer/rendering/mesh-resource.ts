// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GdtfGeometrySource } from "../../../types/index";

/** Identify immutable mesh bytes independently of a mutable path or selected fixture mode. */
export function meshResourceKey(
  source: GdtfGeometrySource,
  modelName: string,
): string {
  return JSON.stringify([source.archiveSha256, modelName]);
}

/** Encode the indexed UTF-8 path and exact revision into the backend resource route. */
export function meshResourcePath(
  source: GdtfGeometrySource,
  modelName: string,
): string {
  const bytes = new TextEncoder().encode(source.path);
  const encodedPath = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `/api/mesh/${encodedPath}/${source.archiveSha256}/${encodeURIComponent(modelName)}`;
}
