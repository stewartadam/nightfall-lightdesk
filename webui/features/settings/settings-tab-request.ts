// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";

/** Categories shown as tabs in the Settings dialog. */
export type SettingsTab =
  | "general"
  | "appearance"
  | "editors"
  | "network"
  | "visualizer"
  | "privacy";

/**
 * Tab another surface asked Settings to show the next time it opens, such as the
 * telemetry prompt linking straight to Privacy. Settings clears it once applied.
 */
export const $requestedSettingsTab = atom<SettingsTab | null>(null);

/** Asks the Settings dialog to switch to `tab` when it is next shown. */
export function requestSettingsTab(tab: SettingsTab): void {
  $requestedSettingsTab.set(tab);
}
