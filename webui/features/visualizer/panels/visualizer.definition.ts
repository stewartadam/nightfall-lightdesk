// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ThreeDIcon } from "@squidlab/phosphor-solid/three-d";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Visualizer",
  componentName: "Visualizer",
  title: "3D Visualizer",
  minWidth: 280,
  minHeight: 240,
  icon: ThreeDIcon,
  loadComponent: () => import("./visualizer-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
