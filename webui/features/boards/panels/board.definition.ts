// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import {
  OPEN_PANEL_SETTINGS_CAPABILITY,
  RENDER_PROPERTIES_CAPABILITY,
} from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Board",
  componentName: "BoardPanel",
  title: "Board",
  minWidth: 260,
  minHeight: 160,
  icon: SquaresFourIcon,
  loadComponent: () => import("./board"),
  capabilities: [
    RENDER_PROPERTIES_CAPABILITY.id,
    OPEN_PANEL_SETTINGS_CAPABILITY.id,
  ],
  // Each board opens in its own panel from the Boards list or the object palette.
  showInPalette: false,
  singleton: "multi",
});
