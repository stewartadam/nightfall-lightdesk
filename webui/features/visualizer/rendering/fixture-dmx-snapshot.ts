// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ParameterOutputSnapshot } from "../../../state/appStores";
import type { FixtureElement } from "../../../types";
import type { FixtureElementDmxMap } from "./renderers/renderer-api";
import {
  extractElementDmxData,
  fixtureIntensityValueFromOutputs,
  resetDmxPool,
} from "./visualizer-dmx";

type FixtureDefinitions = Record<string, { elements: FixtureElement[] }>;

/** Converts immutable engine snapshots once while allowing time-dependent optics to run every frame. */
export class FixtureDmxSnapshot {
  private parameters?: ParameterOutputSnapshot;
  private fixtures?: FixtureDefinitions;
  private readonly values = new Map<string, FixtureElementDmxMap>();
  private revisionCounter = 0;

  /**
   * Increments whenever {@link read} rebuilds the records. The returned map is
   * reused in place, so consumers that forward it elsewhere compare revisions
   * rather than map identity to detect new engine output.
   */
  get revision(): number {
    return this.revisionCounter;
  }

  /** Returns owned DMX records until either the engine output or fixture definitions are replaced. */
  read(parameters: ParameterOutputSnapshot, fixtures: FixtureDefinitions) {
    if (parameters === this.parameters && fixtures === this.fixtures)
      return this.values;
    this.revisionCounter++;
    this.parameters = parameters;
    this.fixtures = fixtures;
    this.values.clear();
    resetDmxPool();
    for (const uid in fixtures) {
      const elements = fixtures[uid].elements;
      const outputs = parameters.get(uid);
      if (!outputs) continue;
      const intensity = fixtureIntensityValueFromOutputs(outputs, elements);
      const dmx: FixtureElementDmxMap = new Map();
      for (let i = 0; i < elements.length; i++) {
        if (outputs[i])
          dmx.set(
            elements[i].label,
            extractElementDmxData(outputs[i], elements[i], intensity),
          );
      }
      if (dmx.size) this.values.set(uid, dmx);
    }
    return this.values;
  }
}
