// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { IVisualizerRenderer } from "../rendering/renderers/renderer-api";

export type CameraDragResetScheduler = (callback: () => void) => void;

/**
 * Temporarily disables camera drag controls and re-enables them on the next frame.
 */
export function resetCameraPointerDragForRenderer(
  renderer: () =>
    | Pick<IVisualizerRenderer, "setCameraDragEnabled">
    | null
    | undefined,
  schedule: CameraDragResetScheduler = requestAnimationFrame,
) {
  const activeRenderer = renderer();
  if (!activeRenderer) return;

  activeRenderer.setCameraDragEnabled(false);
  schedule(() => {
    renderer()?.setCameraDragEnabled(true);
  });
}
