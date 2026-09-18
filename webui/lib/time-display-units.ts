// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TimeDisplayPreference } from "../types";
import type { RichTimeDisplayUnit } from "./datagrid-rich-cell-helpers";

export const TIME_DISPLAY_UNITS: readonly RichTimeDisplayUnit[] = [
  "auto",
  "seconds",
  "milliseconds",
  "bpm",
  "hertz",
];

export const TIME_DISPLAY_UNIT_LABELS: Record<RichTimeDisplayUnit, string> = {
  auto: "Auto",
  seconds: "Seconds",
  milliseconds: "Milliseconds",
  bpm: "BPM",
  hertz: "Hertz",
};

/** Converts the desk time display preference into a rich-cell display unit. */
export function timeDisplayUnitFromPreference(
  preference: TimeDisplayPreference | undefined,
): RichTimeDisplayUnit {
  switch (preference) {
    case TimeDisplayPreference.Seconds:
      return "seconds";
    case TimeDisplayPreference.Milliseconds:
      return "milliseconds";
    case TimeDisplayPreference.Bpm:
      return "bpm";
    case TimeDisplayPreference.Hertz:
      return "hertz";
    default:
      return "auto";
  }
}
