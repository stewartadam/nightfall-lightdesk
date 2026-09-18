// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import { DmxValueResolution } from "../types/index";

/**
 * Get the number of DMX channels a resolution occupies.
 */
export function getResolutionChannelWidth(
  resolution: types.DmxValueResolution,
): number {
  switch (resolution) {
    case DmxValueResolution.Fine:
      return 2;
    case DmxValueResolution.UltraFine:
      return 3;
    case DmxValueResolution.Uber:
      return 4;
    default:
      return 1;
  }
}
