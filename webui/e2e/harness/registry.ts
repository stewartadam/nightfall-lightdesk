// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Browser-side harnesses specs load with `window.__nightfallHarness.load(name)`.
 * Each entry is a lazy chunk, so dev servers serve and e2e builds bundle the
 * same set instead of specs importing source paths only Vite's dev server
 * resolves. Mounted fixtures render into the harness page's `#root` on load.
 */
const harnessLoaders = {
  app: () => import("./app"),
  "startup-probe": () => import("./startup-probe"),
  visualizer: () => import("./visualizer"),
  three: () => import("../fixtures/three-api"),
  optics: () => import("../fixtures/optics-harness"),
  "emitter-batch-scene": () => import("../fixtures/emitter-batch-scene"),
  "emitter-volume-uniforms": () =>
    import("../fixtures/emitter-volume-uniforms"),
  "timeline-playback": () => import("../fixtures/timeline-playback"),
  "data-grid-column-autosize": () =>
    import("../fixtures/data-grid-column-autosize"),
  "data-grid-editor-alignment": () =>
    import("../fixtures/data-grid-editor-alignment"),
  "surface-budget-metrics": () => import("../fixtures/surface-budget-metrics"),
  "waveform-editor": () => import("../fixtures/waveform-editor"),
};

export type HarnessName = keyof typeof harnessLoaders;

/** Module namespace each harness name resolves to. */
export type HarnessModules = {
  [Name in HarnessName]: Awaited<ReturnType<(typeof harnessLoaders)[Name]>>;
};

/** Loader published on `window.__nightfallHarness`. */
export type NightfallHarness = {
  load<Name extends HarnessName>(name: Name): Promise<HarnessModules[Name]>;
};

/** Loads one harness module by name, rejecting names the registry does not know. */
export function loadHarness<Name extends HarnessName>(
  name: Name,
): Promise<HarnessModules[Name]> {
  const loader = harnessLoaders[name];
  if (!loader) {
    return Promise.reject(new Error(`Unknown e2e harness: ${String(name)}`));
  }
  return loader() as Promise<HarnessModules[Name]>;
}
