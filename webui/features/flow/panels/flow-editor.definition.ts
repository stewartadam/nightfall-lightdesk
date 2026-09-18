// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ShareIcon } from "@squidlab/phosphor-solid/share";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-FlowEditor",
  componentName: "FlowEditor",
  title: "Flow Editor",
  minWidth: 360,
  minHeight: 240,
  icon: ShareIcon,
  loadComponent: () => import("./flow-editor-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id],
  showInPalette: false,
  singleton: "singleton",
});
