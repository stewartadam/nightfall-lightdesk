// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Minimal ownership contract required while asynchronous initialization runs. */
interface DisposableRenderer {
  dispose(): void;
}

/**
 * Awaits renderer creation and disposes the result when its owner disappeared
 * before initialization completed.
 */
export async function initializeOwnedVisualizerRenderer<
  Renderer extends DisposableRenderer,
>(
  createRenderer: () => Promise<Renderer>,
  isDisposed: () => boolean,
  activate: (renderer: Renderer) => void,
): Promise<void> {
  const newRenderer = await createRenderer();
  if (isDisposed()) {
    newRenderer.dispose();
    return;
  }
  activate(newRenderer);
}
