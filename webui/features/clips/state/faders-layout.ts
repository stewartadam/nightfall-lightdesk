// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentAtom } from "@nanostores/persistent";
export const FADERS_HEIGHT_STORAGE_KEY = "nightfall-clip-panel:faders-height";
export const FADERS_COLLAPSED_STORAGE_KEY =
  "nightfall-clip-panel:faders-collapsed";
export const DEFAULT_FADERS_HEIGHT = 320;
export const MIN_FADERS_HEIGHT = 300;
export const COLLAPSED_FADERS_HEIGHT = 46;
export const MAX_FADERS_PANEL_RATIO = 0.75;

/**
 * Keeps the faders within usable panel bounds while preserving compact layouts.
 */
export function clampFadersHeight(
  height: number,
  panelHeight?: number,
): number {
  const maxHeight =
    panelHeight === undefined
      ? 520
      : Math.max(
          MIN_FADERS_HEIGHT,
          Math.floor(panelHeight * MAX_FADERS_PANEL_RATIO),
        );
  return Math.min(Math.max(height, MIN_FADERS_HEIGHT), maxHeight);
}

export const fadersHeightPreference = persistentAtom<number>(
  FADERS_HEIGHT_STORAGE_KEY,
  DEFAULT_FADERS_HEIGHT,
  {
    decode: (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed)
        ? clampFadersHeight(parsed)
        : DEFAULT_FADERS_HEIGHT;
    },
    encode: String,
  },
);

export const fadersCollapsedPreference = persistentAtom<boolean>(
  FADERS_COLLAPSED_STORAGE_KEY,
  false,
  {
    decode: (value) => value === "true",
    encode: String,
  },
);

/**
 * Reads the user's persisted faders height, falling back when storage is absent.
 */
export function loadFadersHeight(): number {
  return fadersHeightPreference.get();
}

/**
 * Saves the user's preferred faders height when browser storage is available.
 */
export function persistFadersHeight(height: number): void {
  fadersHeightPreference.set(height);
}

/**
 * Reads whether the user last left the faders collapsed.
 */
export function loadFadersCollapsed(): boolean {
  return fadersCollapsedPreference.get();
}

/**
 * Saves the user's faders collapsed preference.
 */
export function persistFadersCollapsed(collapsed: boolean): void {
  fadersCollapsedPreference.set(collapsed);
}
