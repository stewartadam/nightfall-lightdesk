// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { HeldButtonEffect } from "../../../types";

/** Short tag and explanation shown wherever a held slot button changes a playback. */
export interface HeldButtonTag {
  /** One-word tag, such as "Swopped". */
  label: string;
  /** Sentence naming the slot whose held button causes the change. */
  title: string;
  /** Whether the playback is taken out of the output entirely. */
  takenOut: boolean;
}

/**
 * Describes how a held Flash or Swop changes a playback, so every view names the slot
 * responsible in the same words. Returns `undefined` when no held button concerns it.
 */
export function heldButtonTag(
  effect: HeldButtonEffect | null | undefined,
): HeldButtonTag | undefined {
  switch (effect?.type) {
    case "Flashed":
      return {
        label: "Flashed",
        title: `Played at full by the button held on slot ${effect.data.control_index}`,
        takenOut: false,
      };
    case "SwoppedOut":
      return {
        label: "Swopped",
        title: `Taken out by the Swop held on slot ${effect.data.control_index}`,
        takenOut: true,
      };
    default:
      return undefined;
  }
}
