// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-SelectionVisualizer",
  componentName: "SelectionVisualizer",
  title: "Selection Inspector",
  minWidth: 220,
  minHeight: 160,
  icon: SelectionIcon,
  loadComponent: () => import("./selection-visualizer-panel"),
  showInPalette: true,
  singleton: "singleton",
});
