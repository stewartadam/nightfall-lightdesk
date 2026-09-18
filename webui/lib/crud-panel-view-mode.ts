// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";

export type CrudPanelViewMode = "grid" | "list";

/** Callbacks fired when a CRUD panel moves between persisted view modes. */
interface ChangeCrudPanelViewModeOptions {
  onEnterGridMode?: () => void;
  onEnterListMode?: () => void;
}

const STORAGE_PREFIX = "nightfall-crud-panel-view-mode";

const isValidViewMode = (value: string): value is CrudPanelViewMode =>
  value === "grid" || value === "list";

const storageKeyFor = (panelKey: string) => `${STORAGE_PREFIX}:${panelKey}`;

/**
 * Creates a persistent store for a single panel view-mode key.
 */
function createCrudPanelViewModeStore(
  panelKey: string,
  fallback: CrudPanelViewMode,
) {
  return persistentAtom<CrudPanelViewMode>(storageKeyFor(panelKey), fallback, {
    decode: (value) => (isValidViewMode(value) ? value : fallback),
    encode: (value) => value,
  });
}

/**
 * Read a panel's saved view mode, falling back when storage is unavailable or invalid.
 */
export function loadCrudPanelViewMode(
  panelKey: string,
  fallback: CrudPanelViewMode = "grid",
): CrudPanelViewMode {
  return createCrudPanelViewModeStore(panelKey, fallback).get();
}

/**
 * Persist a panel's selected view mode when browser storage is available.
 */
function persistCrudPanelViewMode(
  panelKey: string,
  viewMode: CrudPanelViewMode,
): void {
  createCrudPanelViewModeStore(panelKey, viewMode).set(viewMode);
}

/**
 * Applies and persists a new view mode, running transition hooks when needed.
 */
export function changeCrudPanelViewMode(
  panelKey: string,
  currentViewMode: CrudPanelViewMode,
  nextViewMode: CrudPanelViewMode,
  onViewModeChange: (mode: CrudPanelViewMode) => void,
  options?: ChangeCrudPanelViewModeOptions,
): void {
  if (currentViewMode !== nextViewMode) {
    if (nextViewMode === "list") {
      options?.onEnterListMode?.();
    } else {
      options?.onEnterGridMode?.();
    }
  }

  onViewModeChange(nextViewMode);
  persistCrudPanelViewMode(panelKey, nextViewMode);
}
