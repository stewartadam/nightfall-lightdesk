// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Selects the host adapter used by the engine runtime worker. */
export type EngineRuntimeConfig =
  | {
      mode: "remote";
      websocketUrl: string;
    }
  | {
      mode: "embedded-demo";
      sampleId: string;
      showfileUrl: string;
      tickRateHz?: number;
    };

/** Browser-engine measurements exposed for feasibility tests and diagnostics. */
export interface BrowserDemoRuntimeInfo {
  adapter: "embedded-demo";
  sampleId: string;
  initMs: number;
  tickRateHz: number;
  tickCount: number;
  requestedDeltaMs: number;
  appliedDeltaMs: number;
  maxDeltaMs: number;
  tickAverageMs: number;
  tickMaxMs: number;
  wasmMemoryBytes: number;
}

/** Commands accepted by the engine runtime worker independent of its host adapter. */
export type EngineRuntimeWorkerRequest =
  | { type: "start"; config: EngineRuntimeConfig }
  | { type: "submit"; data: string | object }
  | { type: "stop" }
  | { type: "pullFrame" }
  | { type: "resumeAfterResyncRequest" };
