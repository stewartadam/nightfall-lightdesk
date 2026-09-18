// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { VisualizerCanvasApi } from "../controllers/visualizer-canvas-api";

type VisualizerApiMap = Record<string, VisualizerCanvasApi>;

type VisualizerDebugWindowLike = {
  visualizerApis?: VisualizerApiMap;
  visualizerActivePanelId?: string;
  getVisualizerApi?: (panelId?: string) => VisualizerCanvasApi | undefined;
  visualizerApi?: VisualizerCanvasApi;
};

declare global {
  interface Window extends VisualizerDebugWindowLike {}
}

function getWindowLike(
  windowLike: VisualizerDebugWindowLike | undefined,
): VisualizerDebugWindowLike | null {
  if (windowLike) return windowLike;
  if (typeof window === "undefined") return null;
  return window;
}

function ensureApiMap(windowLike: VisualizerDebugWindowLike): VisualizerApiMap {
  if (!windowLike.visualizerApis) {
    windowLike.visualizerApis = {};
  }
  return windowLike.visualizerApis;
}

function resolveFirstAvailablePanelId(
  apis: VisualizerApiMap,
): string | undefined {
  const panelIds = Object.keys(apis);
  return panelIds.length > 0 ? panelIds[0] : undefined;
}

/**
 * Installs stable window accessors for querying visualizer debug APIs by panel ID.
 */
function installApiAccessors(windowLike: VisualizerDebugWindowLike): void {
  if (!windowLike.getVisualizerApi) {
    windowLike.getVisualizerApi = (panelId?: string) => {
      const apis = ensureApiMap(windowLike);
      if (panelId) return apis[panelId];
      if (
        windowLike.visualizerActivePanelId &&
        apis[windowLike.visualizerActivePanelId]
      ) {
        return apis[windowLike.visualizerActivePanelId];
      }
      const fallbackPanelId = resolveFirstAvailablePanelId(apis);
      return fallbackPanelId ? apis[fallbackPanelId] : undefined;
    };
  }

  if (!Object.getOwnPropertyDescriptor(windowLike, "visualizerApi")) {
    Object.defineProperty(windowLike, "visualizerApi", {
      configurable: true,
      enumerable: false,
      get: () => windowLike.getVisualizerApi?.(),
    });
  }
}

export function registerVisualizerDebugApi(
  panelId: string,
  api: VisualizerCanvasApi,
  windowLike?: VisualizerDebugWindowLike,
): void {
  const target = getWindowLike(windowLike);
  if (!target) return;
  const apis = ensureApiMap(target);
  apis[panelId] = api;
  if (!target.visualizerActivePanelId) {
    target.visualizerActivePanelId = panelId;
  }
  installApiAccessors(target);
}

export function setActiveVisualizerDebugApiPanel(
  panelId: string | null,
  windowLike?: VisualizerDebugWindowLike,
): void {
  const target = getWindowLike(windowLike);
  if (!target) return;
  const apis = ensureApiMap(target);

  if (panelId && apis[panelId]) {
    target.visualizerActivePanelId = panelId;
    return;
  }

  target.visualizerActivePanelId = resolveFirstAvailablePanelId(apis);
}

export function unregisterVisualizerDebugApi(
  panelId: string,
  windowLike?: VisualizerDebugWindowLike,
): void {
  const target = getWindowLike(windowLike);
  if (!target) return;
  const apis = ensureApiMap(target);
  if (!apis[panelId]) return;

  delete apis[panelId];

  if (target.visualizerActivePanelId === panelId) {
    target.visualizerActivePanelId = resolveFirstAvailablePanelId(apis);
  }
}
