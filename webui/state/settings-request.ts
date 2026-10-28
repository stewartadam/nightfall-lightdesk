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
  | "keyboard"
  | "accounts"
  | "privacy";

/** Place in the Settings dialog to show: a tab, and optionally one setting on it to focus. */
export interface SettingsTarget {
  tab: SettingsTab;
  /** `setting` key of the settings row whose control receives focus. */
  setting?: string;
}

/**
 * Where another surface asked Settings to open, such as the telemetry prompt linking straight
 * to Privacy. Settings clears it once applied.
 */
export const $requestedSettings = atom<SettingsTarget | null>(null);

/** Settings row key of the route overlap validation mode, on the General tab. */
export const ROUTE_VALIDATION_SETTING = "route-validation-mode";

/** Settings row key of the network interface Art-Net and sACN use, on the Network tab. */
export const NETWORK_INTERFACE_SETTING = "network-interface";
