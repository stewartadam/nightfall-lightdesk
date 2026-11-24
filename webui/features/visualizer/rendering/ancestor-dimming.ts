// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { EmitterData } from "../model/types";

/**
 * Scales each element's light by the dimmers that sit above its apertures in
 * the fixture, as a real fixture multiplies a master dimmer into the lamps
 * below it: a blinder whose master is at zero stays dark even while each
 * lamp's own dimmer is at full.
 *
 * Only elements with an intensity control of their own are scaled; an element
 * without one already takes the fixture-level dimmer. Every scale is worked
 * out before any color changes, so an element that is itself dimmed still
 * passes on its own level, not the dimmed one.
 *
 * @param emitters - The fixture's apertures, naming the elements dimming each.
 * @param colors - Each element's output this frame, keyed by element label;
 *   entries are scaled in place.
 * @param ownsIntensity - Whether an element has a dimmer of its own.
 */
export function applyAncestorDimmers(
  emitters: Iterable<Pick<EmitterData, "controlledElement" | "dimmedBy">>,
  colors: Map<string, { intensity: number }>,
  ownsIntensity: (label: string) => boolean,
): void {
  const scales = new Map<string, number>();
  for (const { controlledElement, dimmedBy } of emitters) {
    if (!dimmedBy?.length || scales.has(controlledElement)) continue;
    if (!ownsIntensity(controlledElement)) continue;
    let scale = 1;
    for (const label of dimmedBy) {
      scale *= colors.get(label)?.intensity ?? 1;
    }
    scales.set(controlledElement, scale);
  }
  for (const [label, scale] of scales) {
    const color = colors.get(label);
    if (color) color.intensity *= scale;
  }
}
