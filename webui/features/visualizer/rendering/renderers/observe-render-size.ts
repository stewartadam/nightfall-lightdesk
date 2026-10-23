// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { debounce, leadingAndTrailing } from "@solid-primitives/scheduled";

/** How long the container must keep one size before the drawing buffer follows it. */
const RENDER_RESIZE_SETTLE_MS = 100;

/**
 * Reports a renderer container's content size right away when it starts changing, then once
 * more with the final size after it settles. Each report resizes the drawing buffer and its
 * render targets, which is slow enough on some GPUs (such as WebView2 on Windows) to stall
 * every frame of a window resize. The canvas is sized by CSS, so while the size keeps changing
 * it stretches the previous frame. Returns a function that stops observing.
 */
export function observeRenderSize(
  container: Element,
  onResize: (width: number, height: number) => void,
): () => void {
  const report = leadingAndTrailing(
    debounce,
    onResize,
    RENDER_RESIZE_SETTLE_MS,
  );
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) report(width, height);
    }
  });
  observer.observe(container);
  return () => {
    observer.disconnect();
    report.clear();
  };
}
