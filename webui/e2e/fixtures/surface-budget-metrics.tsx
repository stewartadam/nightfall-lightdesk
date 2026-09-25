// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { VisualizerMetricsSection } from "../../features/instrumentation/components/visualizer-metrics-section";
import type { VisualizerStats } from "../../state/appStores";
import "../../index.css";

/** Displays the production instrumentation component with deterministic light-budget transitions. */
function SurfaceBudgetMetrics() {
  const [omitted, setOmitted] = createSignal(0);
  const [reduced, setReduced] = createSignal(0);
  const [gobos, setGobos] = createSignal(0);
  const base: VisualizerStats = {
    fps: 60,
    frameToFrameMs: 16.67,
    updateFixturesMs: 1,
    totalRenderMs: 3,
    postProcessMs: 0,
    scenePassMs: 3,
    volumetricPassMs: 0,
    gaussianBlurMs: 0,
    bloomMs: 0,
    renderMode: "worker",
    gpuMs: 4,
  };
  return (
    <main class="m-4 max-w-xl space-y-4 p-4">
      <button type="button" onClick={() => setOmitted(7)}>
        Exceed surface budget
      </button>
      <button type="button" onClick={() => setOmitted(0)}>
        Restore surface budget
      </button>
      <VisualizerMetricsSection
        stats={{
          ...base,
          omittedSurfaceLights: omitted(),
          reducedPrismEmitters: reduced(),
          reducedGoboEmitters: gobos(),
        }}
      />
      <button type="button" onClick={() => setReduced(2)}>
        Reduce prism detail
      </button>
      <button type="button" onClick={() => setReduced(0)}>
        Restore prism detail
      </button>
      <button type="button" onClick={() => setGobos(3)}>
        Exceed gobo budget
      </button>
      <button type="button" onClick={() => setGobos(0)}>
        Restore gobo budget
      </button>
    </main>
  );
}

render(() => <SurfaceBudgetMetrics />, document.getElementById("root")!);
