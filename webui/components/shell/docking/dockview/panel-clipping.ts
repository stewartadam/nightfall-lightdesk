// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";

/** Clips detached grid content to the workspace when panel minimums exceed its available size. */
export function bindPanelClipping(api: DockviewApi, host: HTMLElement) {
  let frame: number | undefined;
  const clipped = new Set<HTMLElement>();
  let observedGrid: HTMLElement | undefined;

  /** Coalesces Dockview layout notifications before measuring the settled panel positions. */
  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(update);
  }

  /** Intersects each grid panel with the central viewport without clipping floating or edge panels. */
  function update() {
    frame = undefined;
    const grid = host.querySelector<HTMLElement>(".dv-dockview");
    if (!grid) return;
    if (grid !== observedGrid) {
      if (observedGrid) resize.unobserve(observedGrid);
      observedGrid = grid;
      resize.observe(grid);
    }
    const viewport = grid.getBoundingClientRect();
    const next = new Set<HTMLElement>();
    const changes: { element: HTMLElement; clip: string }[] = [];
    for (const panel of api.panels) {
      if (panel.api.location.type !== "grid" || !panel.api.isVisible) continue;
      const content = panel.view.content.element;
      // Dockview's detached focus wrapper receives pointer events even where its
      // child is clipped. Clip the wrapper so hidden pixels cannot activate it.
      const element =
        content.closest<HTMLElement>(".dv-render-overlay") ?? content;
      // Detached content is positioned on a later frame after a tab becomes visible.
      // Its in-grid placeholder already has the destination bounds.
      const container = panel.group.element.querySelector<HTMLElement>(
        ".dv-content-container",
      );
      if (!container) continue;
      const bounds = container.getBoundingClientRect();
      const insets = [
        Math.max(0, viewport.top - bounds.top),
        Math.max(0, bounds.right - viewport.right),
        Math.max(0, bounds.bottom - viewport.bottom),
        Math.max(0, viewport.left - bounds.left),
      ];
      if (!insets.some((inset) => inset > 0)) continue;
      next.add(element);
      changes.push({
        element,
        clip: `inset(${insets.map((inset) => `${inset}px`).join(" ")})`,
      });
    }
    for (const element of clipped) {
      if (!next.has(element)) {
        element.classList.remove("nf-grid-panel-clip");
        element.style.removeProperty("--nf-grid-panel-clip");
      }
    }
    clipped.clear();
    for (const { element, clip } of changes) {
      element.classList.add("nf-grid-panel-clip");
      element.style.setProperty("--nf-grid-panel-clip", clip);
      clipped.add(element);
    }
  }

  const subscription = api.onDidLayoutChange(schedule);
  const resize = new ResizeObserver(schedule);
  resize.observe(host);
  schedule();
  return {
    /** Releases observers and restores panel styles before the host is disposed. */
    dispose() {
      subscription.dispose();
      resize.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const element of clipped) {
        element.classList.remove("nf-grid-panel-clip");
        element.style.removeProperty("--nf-grid-panel-clip");
      }
      clipped.clear();
    },
  };
}
