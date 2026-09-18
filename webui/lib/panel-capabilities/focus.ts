// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelCapabilityContract } from "./types";

export const PANEL_FOCUS_CAPABILITY: PanelCapabilityContract<
  "focus-panel",
  Record<string, never>
> = {
  id: "focus-panel",
  description: "Participate in panel focus and keyboard shortcut ownership.",
};

export type PanelFocusCapability = typeof PANEL_FOCUS_CAPABILITY;
