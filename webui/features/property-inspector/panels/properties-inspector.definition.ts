// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SlidersHorizontalIcon } from "@squidlab/phosphor-solid/sliders-horizontal";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-PropertiesInspector",
  componentName: "PropertiesInspector",
  title: "Properties",
  icon: SlidersHorizontalIcon,
  minWidth: 260,
  minHeight: 240,
  loadComponent: () => import("./properties-inspector-panel"),
  showInPalette: true,
  singleton: "singleton",
});
