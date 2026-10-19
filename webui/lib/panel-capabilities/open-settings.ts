// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelCapabilityContract } from "./types";

export const OPEN_PANEL_SETTINGS_CAPABILITY: PanelCapabilityContract<
  "open-panel-settings",
  Record<string, never>
> = {
  id: "open-panel-settings",
  description:
    "Open the panel's own settings from Settings… in its tab menu. Register only while there is something to configure.",
};

export type OpenPanelSettingsCapability = typeof OPEN_PANEL_SETTINGS_CAPABILITY;
