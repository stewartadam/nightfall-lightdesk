// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { OscMapping } from "../../../../types";

/** Checks the argument index and backend-representable scalar range before submitting a draft. */
export function oscInputOptionsError(
  mapping: Pick<OscMapping, "input" | "arg_index">,
): string | undefined {
  if (
    mapping.arg_index !== undefined &&
    mapping.arg_index !== null &&
    (!Number.isInteger(mapping.arg_index) ||
      mapping.arg_index < 0 ||
      mapping.arg_index > 255)
  )
    return "Choose an argument index from 0 to 255.";
  if (mapping.input.type !== "Continuous") return undefined;
  const minimum = Math.fround(mapping.input.data.minimum);
  const maximum = Math.fround(mapping.input.data.maximum);
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum ||
    !Number.isFinite(Math.fround(maximum - minimum))
  )
    return "Enter a finite range with a maximum greater than its minimum.";
  return undefined;
}
