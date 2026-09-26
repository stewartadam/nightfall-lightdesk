// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { EmitterColor } from "./geometry-builder";
import type { FixtureElementDmxMap } from "./renderers/renderer-api";
import { applyStrobeShutterIntensity } from "./visualizer-dmx";

/** Reuses fixture color records while retaining arbitrary normalized GDTF control keys. */
export class FixtureColorState {
  private readonly colors = new Map<
    string,
    EmitterColor & Record<string, number | undefined>
  >();

  /** Returns borrowed colors valid until the next update; absent elements and controls are cleared. */
  update(
    elements: FixtureElementDmxMap,
    fixtureStrobeShutter: number | undefined,
    seconds: number,
  ): Map<string, EmitterColor & Record<string, number | undefined>> {
    for (const key of this.colors.keys()) {
      if (!elements.has(key)) this.colors.delete(key);
    }
    for (const [key, dmx] of elements) {
      let color = this.colors.get(key);
      if (!color) {
        color = { red: 0, green: 0, blue: 0, intensity: 0 };
        this.colors.set(key, color);
      }
      for (const attribute in color) {
        if (dmx[attribute] === undefined) color[attribute] = undefined;
      }
      Object.assign(color, dmx);
      color.red = dmx.red ?? 0;
      color.green = dmx.green ?? 0;
      color.blue = dmx.blue ?? 0;
      color.intensity = applyStrobeShutterIntensity(
        dmx.intensity ?? 0,
        dmx.strobeShutter ?? fixtureStrobeShutter,
        seconds,
      );
    }
    return this.colors;
  }
}
