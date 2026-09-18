// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { SlidersIcon } from "@squidlab/phosphor-solid/sliders";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-OscInput",
  componentName: "OscInput",
  title: "OSC Input",
  minWidth: 220,
  minHeight: 160,
  icon: SlidersIcon,
  loadComponent: () => import("./panel"),
  showInPalette: true,
  singleton: "singleton",
});
