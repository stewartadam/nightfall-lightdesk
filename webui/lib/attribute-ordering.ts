// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { compareAttributes as compareAttributeMetadata } from "./attribute-metadata";

/**
 * Sort an array of attribute strings in the consistent order.
 * This function creates a new sorted array without modifying the original.
 */
export function sortedAttributes(attributes: string[]): string[] {
  return [...attributes].sort(compareAttributes);
}

/**
 * Compare two attribute strings according to the consistent ordering.
 * Returns negative if a < b, positive if a > b, zero if equal.
 */
function compareAttributes(a: string, b: string): number {
  return compareAttributeMetadata(a, b);
}
