// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TerminalIcon } from "@squidlab/phosphor-solid/terminal";
import {
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
} from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Macros",
  componentName: "MacrosPanel",
  title: "Macros",
  minWidth: 320,
  minHeight: 160,
  icon: TerminalIcon,
  loadComponent: () => import("./macro-list"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id, REVEAL_OBJECT_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
