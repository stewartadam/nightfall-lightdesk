// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
export const CONTROLS_HEIGHT_STORAGE_KEY =
  "nightfall-clip-panel:controls-height";
export const CONTROLS_COLLAPSED_STORAGE_KEY =
  "nightfall-clip-panel:controls-collapsed";
export const DEFAULT_CONTROLS_HEIGHT = 320;
export const MIN_CONTROLS_HEIGHT = 160;
export const COLLAPSED_CONTROLS_HEIGHT = 46;
export const MAX_CONTROLS_PANEL_RATIO = 0.75;

/**
 * Keeps the controls within usable panel bounds while preserving compact layouts.
 */
export function clampControlsHeight(
  height: number,
  panelHeight?: number,
): number {
  const maxHeight =
    panelHeight === undefined
      ? 520
      : Math.max(
          MIN_CONTROLS_HEIGHT,
          Math.floor(panelHeight * MAX_CONTROLS_PANEL_RATIO),
        );
  return Math.min(Math.max(height, MIN_CONTROLS_HEIGHT), maxHeight);
}

export const controlsHeightPreference = persistentAtom<number>(
  CONTROLS_HEIGHT_STORAGE_KEY,
  DEFAULT_CONTROLS_HEIGHT,
  {
    decode: (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed)
        ? clampControlsHeight(parsed)
        : DEFAULT_CONTROLS_HEIGHT;
    },
    encode: String,
  },
);

export const controlsCollapsedPreference = persistentAtom<boolean>(
  CONTROLS_COLLAPSED_STORAGE_KEY,
  false,
  {
    decode: (value) => value === "true",
    encode: String,
  },
);

/**
 * Reads the user's persisted controls height, falling back when storage is absent.
 */
export function loadControlsHeight(): number {
  return controlsHeightPreference.get();
}

/**
 * Saves the user's preferred controls height when browser storage is available.
 */
export function persistControlsHeight(height: number): void {
  controlsHeightPreference.set(height);
}

/**
 * Reads whether the user last left the controls collapsed.
 */
export function loadControlsCollapsed(): boolean {
  return controlsCollapsedPreference.get();
}

/**
 * Saves the user's controls collapsed preference.
 */
export function persistControlsCollapsed(collapsed: boolean): void {
  controlsCollapsedPreference.set(collapsed);
}
