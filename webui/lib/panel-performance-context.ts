// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createContext, getOwner, useContext } from "solid-js";

export interface PanelPerformanceContext {
  panelId: string;
  componentName?: string;
}

const SolidPanelPerformanceContext =
  createContext<PanelPerformanceContext | null>(null);

export const PanelPerformanceContextProvider =
  SolidPanelPerformanceContext.Provider;

let currentPanelPerformanceContext: PanelPerformanceContext | null = null;

/** Normalizes panel context so instrumentation never publishes empty labels. */
function normalizePanelPerformanceContext(
  context: PanelPerformanceContext,
): PanelPerformanceContext {
  return {
    panelId: context.panelId.trim() || "unknown-panel",
    componentName: context.componentName?.trim() || undefined,
  };
}

/** Runs synchronous panel setup work with attribution for performance probes. */
export function withPanelPerformanceContext<T>(
  context: PanelPerformanceContext,
  callback: () => T,
): T {
  const previousContext = currentPanelPerformanceContext;
  currentPanelPerformanceContext = normalizePanelPerformanceContext(context);
  try {
    return callback();
  } finally {
    currentPanelPerformanceContext = previousContext;
  }
}

/** Returns the panel currently registering synchronous reactive work. */
export function getCurrentPanelPerformanceContext(): PanelPerformanceContext | null {
  if (currentPanelPerformanceContext) return currentPanelPerformanceContext;
  if (!getOwner()) return null;
  return useContext(SolidPanelPerformanceContext) ?? null;
}
