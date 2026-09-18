// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeAttributeName } from "./utils";

const COLOR_PATH_VECTOR_ATTRIBUTES = new Set([
  "Red",
  "Green",
  "Blue",
  "White",
  "Amber",
  "WarmWhite",
  "CoolWhite",
  "UV",
  "Cyan",
  "Magenta",
  "Yellow",
]);

/** Returns whether an attribute is part of a runtime-supported color path output group. */
export function isColorPathVectorAttribute(attribute: string): boolean {
  return COLOR_PATH_VECTOR_ATTRIBUTES.has(normalizeAttributeName(attribute));
}

/** Returns whether a cue value cell should be marked as path-derived output. */
export function isColorPathDrivenAttribute(
  colorPathId: number | null | undefined,
  attribute: string,
): boolean {
  return colorPathId != null && isColorPathVectorAttribute(attribute);
}
