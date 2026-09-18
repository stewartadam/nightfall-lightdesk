// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
import type { DockviewApi } from "dockview";
import {
  cloneSerializedLayout,
  createBlankSerializedLayout,
  createSerializedLayout,
  isSerializedLayout,
  SERIALIZED_LAYOUT_VERSION,
  type SerializedLayout,
  sanitizeSerializedLayout,
} from "./dockview-layout";
import { getLogger } from "./logger";

const log = getLogger(import.meta.url);

export type { SerializedLayout } from "./dockview-layout";

/** Accepts the ten numbered layout shortcut slots and narrows valid input to a number. */
export function isLayoutShortcutSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}

export interface StoredPanelLayout extends SerializedLayout {
  id: string;
  name: string;
  shownInSwitcher: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LayoutStorageState {
  version: number;
  activeLayoutId: string | null;
  sessionLayout: SerializedLayout | null;
  layouts: StoredPanelLayout[];
}

const LAYOUT_STORAGE_KEY = "nightfall-ui-layouts";
// Current layout format version (increment if format changes to handle migrations)
const CURRENT_VERSION = SERIALIZED_LAYOUT_VERSION;

function emptyState(): LayoutStorageState {
  return {
    version: CURRENT_VERSION,
    activeLayoutId: null,
    sessionLayout: null,
    layouts: [],
  };
}

function nowMs(): number {
  return Date.now();
}

function createLayoutId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `layout-${nowMs()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneStoredPanelLayout(layout: StoredPanelLayout): StoredPanelLayout {
  const cloned = JSON.parse(JSON.stringify(layout)) as StoredPanelLayout;
  return {
    ...cloneSerializedLayout(cloned),
    id: cloned.id,
    name: cloned.name,
    shownInSwitcher: cloned.shownInSwitcher !== false,
    createdAt: cloned.createdAt,
    updatedAt: cloned.updatedAt,
  };
}

function cloneLayoutStorageState(
  state: LayoutStorageState,
): LayoutStorageState {
  return {
    version: CURRENT_VERSION,
    activeLayoutId: state.activeLayoutId ?? null,
    sessionLayout: state.sessionLayout
      ? cloneSerializedLayout(state.sessionLayout)
      : null,
    layouts: state.layouts.map(cloneStoredPanelLayout),
  };
}

function normalizeName(name: string): string {
  return name.trim();
}

function isStoredPanelLayout(value: unknown): value is StoredPanelLayout {
  if (!isSerializedLayout(value)) {
    return false;
  }

  const candidate = value as Partial<StoredPanelLayout>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

function sanitizeStoredPanelLayout(value: unknown): StoredPanelLayout | null {
  if (!isStoredPanelLayout(value)) {
    return null;
  }

  return cloneStoredPanelLayout(value);
}

/**
 * Normalizes persisted layout storage data and drops invalid entries.
 */
function sanitizeLayoutStorageState(value: unknown): LayoutStorageState {
  if (value === null || typeof value !== "object") {
    return emptyState();
  }

  const parsed = value as Partial<LayoutStorageState>;
  if (parsed.version !== CURRENT_VERSION) {
    log.warn(
      `Layout store version mismatch. Saved: ${parsed.version}, Current: ${CURRENT_VERSION}`,
    );
    return emptyState();
  }

  const layouts = Array.isArray(parsed.layouts)
    ? parsed.layouts.flatMap((layout) => {
        const sanitized = sanitizeStoredPanelLayout(layout);
        return sanitized ? [sanitized] : [];
      })
    : [];
  const activeLayoutId =
    typeof parsed.activeLayoutId === "string" &&
    layouts.some((layout) => layout.id === parsed.activeLayoutId)
      ? parsed.activeLayoutId
      : null;

  return {
    version: CURRENT_VERSION,
    activeLayoutId,
    sessionLayout: sanitizeSerializedLayout(parsed.sessionLayout),
    layouts,
  };
}

/**
 * Decodes persisted layout storage state.
 */
function decodeLayoutStorageState(value: string): LayoutStorageState {
  if (value === "undefined") {
    return emptyState();
  }

  try {
    return sanitizeLayoutStorageState(JSON.parse(value));
  } catch {
    return emptyState();
  }
}

export const layoutStorageStore = persistentAtom<LayoutStorageState>(
  LAYOUT_STORAGE_KEY,
  emptyState(),
  {
    decode: decodeLayoutStorageState,
    encode: (state) =>
      JSON.stringify({
        ...sanitizeLayoutStorageState(state),
        version: CURRENT_VERSION,
      }),
  },
);

function loadState(): LayoutStorageState {
  return cloneLayoutStorageState(layoutStorageStore.get());
}

function persistState(state: LayoutStorageState): boolean {
  try {
    layoutStorageStore.set(sanitizeLayoutStorageState(state));
    return true;
  } catch (error) {
    log.error("Failed to persist layout store:", error);
    return false;
  }
}

/**
 * Save the current layout as the active session layout.
 * @param dockApi - The dockview API instance
 * @returns boolean indicating success
 */
export function saveLayout(dockApi: DockviewApi): boolean {
  try {
    if (!dockApi) return false;

    const state = loadState();
    state.sessionLayout = createSerializedLayout(dockApi);
    const success = persistState(state);
    if (success) {
      log.trace("Layout session saved to persistent storage");
    }
    return success;
  } catch (error) {
    log.error("Failed to save layout:", error);
    return false;
  }
}

/**
 * Load the active session layout from persistent storage.
 * @returns The serialized layout or null if none exists
 */
export function loadLayout(): SerializedLayout | null {
  return loadState().sessionLayout;
}

/**
 * Clear the active session layout.
 * @returns boolean indicating success
 */
export function clearLayout(): boolean {
  const state = loadState();
  state.activeLayoutId = null;
  state.sessionLayout = null;
  return persistState(state);
}

export function listStoredLayouts(): StoredPanelLayout[] {
  return loadState()
    .layouts.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return named layouts in their showfile serialization shape.
 */
export function getShowfilePanelLayouts(): StoredPanelLayout[] {
  return loadState().layouts.map(cloneStoredPanelLayout);
}

/**
 * Replace locally cached named layouts with the showfile-backed layout list.
 */
export function replaceStoredLayoutsFromShowfile(
  layouts: StoredPanelLayout[],
): boolean {
  const state = loadState();
  const nextLayouts = layouts.map(cloneStoredPanelLayout);
  state.layouts = nextLayouts;
  if (
    state.activeLayoutId &&
    !nextLayouts.some((layout) => layout.id === state.activeLayoutId)
  ) {
    state.activeLayoutId = null;
  }
  return persistState(state);
}

export function getActiveStoredLayoutId(): string | null {
  return loadState().activeLayoutId;
}

export function getStoredLayout(id: string): StoredPanelLayout | null {
  return loadState().layouts.find((layout) => layout.id === id) ?? null;
}

/** Prepares a uniquely named blank snapshot without changing persistence or active selection. */
export function createBlankStoredLayout(
  dockApi: DockviewApi,
): StoredPanelLayout {
  const names = new Set(loadState().layouts.map((layout) => layout.name));
  let name = "New layout";
  for (let index = 2; names.has(name); index += 1) name = `New layout ${index}`;
  const timestamp = nowMs();
  return {
    ...createBlankSerializedLayout(dockApi),
    id: createLayoutId(),
    name,
    shownInSwitcher: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function storeCurrentLayout(
  dockApi: DockviewApi,
  name: string,
): StoredPanelLayout | null {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return null;
  }

  const timestamp = nowMs();
  const serialized = createSerializedLayout(dockApi);
  const stored: StoredPanelLayout = {
    ...serialized,
    id: createLayoutId(),
    name: normalizedName,
    shownInSwitcher: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const state = loadState();
  state.sessionLayout = serialized;
  state.activeLayoutId = stored.id;
  state.layouts = [...state.layouts, stored];

  return persistState(state) ? stored : null;
}

export function overwriteStoredLayout(
  dockApi: DockviewApi,
  id: string,
): StoredPanelLayout | null {
  const state = loadState();
  const index = state.layouts.findIndex((layout) => layout.id === id);
  if (index === -1) {
    return null;
  }

  const existing = state.layouts[index];
  const serialized = createSerializedLayout(dockApi);
  const updated: StoredPanelLayout = {
    ...serialized,
    id: existing.id,
    name: existing.name,
    shownInSwitcher: existing.shownInSwitcher,
    createdAt: existing.createdAt,
    updatedAt: nowMs(),
  };

  state.layouts = [
    ...state.layouts.slice(0, index),
    updated,
    ...state.layouts.slice(index + 1),
  ];
  state.sessionLayout = serialized;
  state.activeLayoutId = id;

  return persistState(state) ? updated : null;
}

/** Records a successfully restored layout without overwriting the named snapshot. */
export function commitActiveLayout(
  id: string,
  layout: SerializedLayout,
): boolean {
  const state = loadState();
  state.sessionLayout = cloneSerializedLayout(layout);
  state.activeLayoutId = id;
  return persistState(state);
}

export function loadStoredLayout(id: string): SerializedLayout | null {
  const state = loadState();
  const layout = state.layouts.find((entry) => entry.id === id);
  if (!layout) {
    return null;
  }

  const sessionLayout = cloneSerializedLayout(layout);
  state.sessionLayout = sessionLayout;
  state.activeLayoutId = id;

  return persistState(state) ? sessionLayout : null;
}

export function renameStoredLayout(
  id: string,
  name: string,
): StoredPanelLayout | null {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return null;
  }

  const state = loadState();
  const index = state.layouts.findIndex((layout) => layout.id === id);
  if (index === -1) {
    return null;
  }

  const updated: StoredPanelLayout = {
    ...state.layouts[index],
    name: normalizedName,
    updatedAt: nowMs(),
  };
  state.layouts = [
    ...state.layouts.slice(0, index),
    updated,
    ...state.layouts.slice(index + 1),
  ];

  return persistState(state) ? updated : null;
}

export function duplicateStoredLayout(
  id: string,
  name: string,
): StoredPanelLayout | null {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return null;
  }

  const state = loadState();
  const source = state.layouts.find((layout) => layout.id === id);
  if (!source) {
    return null;
  }

  const timestamp = nowMs();
  const duplicate: StoredPanelLayout = {
    ...cloneSerializedLayout(source),
    id: createLayoutId(),
    name: normalizedName,
    shownInSwitcher: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  state.layouts = [...state.layouts, duplicate];

  return persistState(state) ? duplicate : null;
}

export function deleteStoredLayout(id: string): boolean {
  const state = loadState();
  const nextLayouts = state.layouts.filter((layout) => layout.id !== id);
  if (nextLayouts.length === state.layouts.length) {
    return false;
  }

  state.layouts = nextLayouts;
  if (state.activeLayoutId === id) {
    state.activeLayoutId = null;
  }

  return persistState(state);
}

export function clearStoredLayouts(): boolean {
  const state = loadState();
  state.activeLayoutId = null;
  state.layouts = [];
  return persistState(state);
}

export function clearAllLayoutStorage(): boolean {
  return persistState(emptyState());
}
