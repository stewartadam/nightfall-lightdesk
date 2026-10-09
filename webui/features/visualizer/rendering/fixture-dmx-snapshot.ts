// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { measurePerformanceScope } from "../../../lib/performance-marks";
import type { ParameterOutputSnapshot } from "../../../state/appStores";
import type { FixtureElement } from "../../../types";
import { isFixtureEvaluationLoaded } from "./channel-evaluation";
import type { FixtureElementDmxMap } from "./renderers/renderer-api";
import { extractFixtureDmxData, resetDmxPool } from "./visualizer-dmx";

type FixtureDefinitions = Record<string, { elements: FixtureElement[] }>;

/** Converts immutable engine snapshots once while allowing time-dependent optics to run every frame. */
export class FixtureDmxSnapshot {
  private parameters?: ParameterOutputSnapshot;
  private fixtures?: FixtureDefinitions;
  private evaluationLoaded = false;
  private readonly values = new Map<string, FixtureElementDmxMap>();
  /** Inputs each fixture's records were converted from, so unchanged fixtures are not redone. */
  private converted = new Map<string, ConvertedFixture>();
  private revisionCounter = 0;

  /**
   * Takes a probe reporting whether the fixture model can evaluate channels.
   * Converting before it loads yields unlit records, so the snapshot rebuilds
   * once it becomes ready even when the engine output is unchanged, as with a
   * static look.
   */
  constructor(
    private readonly evaluationReady: () => boolean = isFixtureEvaluationLoaded,
  ) {}

  /**
   * Increments whenever {@link read} rebuilds the records. The returned map is
   * reused in place, so consumers that forward it elsewhere compare revisions
   * rather than map identity to detect new engine output.
   */
  get revision(): number {
    return this.revisionCounter;
  }

  /**
   * Returns owned DMX records until the engine output or fixture definitions
   * are replaced, or until the fixture model finishes loading. Each fixture's
   * elements are evaluated together so mode masters and relations can name
   * other elements.
   *
   * A fixture whose output array and definition are the same objects as at its
   * last conversion keeps its records, since the engine snapshot replaces only
   * the outputs that changed. A newly loaded fixture model converts everything.
   */
  read(parameters: ParameterOutputSnapshot, fixtures: FixtureDefinitions) {
    const evaluationLoaded = this.evaluationReady();
    if (
      parameters === this.parameters &&
      fixtures === this.fixtures &&
      evaluationLoaded === this.evaluationLoaded
    )
      return this.values;
    const reusable = evaluationLoaded === this.evaluationLoaded;
    this.revisionCounter++;
    this.parameters = parameters;
    this.fixtures = fixtures;
    this.evaluationLoaded = evaluationLoaded;
    measurePerformanceScope("visualizer.dmx-snapshot.rebuild", () => {
      const previous = this.converted;
      this.converted = new Map();
      this.values.clear();
      // Extraction copies out of the pool, so its transient records can be reused.
      resetDmxPool();
      for (const uid in fixtures) {
        const outputs = parameters.get(uid);
        if (!outputs) continue;
        const fixture = fixtures[uid];
        const last = previous.get(uid);
        const converted =
          reusable && last?.outputs === outputs && last.fixture === fixture
            ? last
            : {
                outputs,
                fixture,
                dmx: dmxMap(extractFixtureDmxData(fixture.elements, outputs)),
              };
        this.converted.set(uid, converted);
        if (converted.dmx) this.values.set(uid, converted.dmx);
      }
    });
    return this.values;
  }
}

/** One fixture's DMX records with the output and definition they were converted from. */
interface ConvertedFixture {
  outputs: readonly Record<string, number>[];
  fixture: { elements: FixtureElement[] };
  /** Records by element label, or `null` when no element has output. */
  dmx: FixtureElementDmxMap | null;
}

/** Collects extracted element records into a map, or `null` when there are none. */
function dmxMap(
  elements: ReturnType<typeof extractFixtureDmxData>,
): FixtureElementDmxMap | null {
  return elements.length ? new Map(elements) : null;
}
