// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ChartBarIcon } from "@squidlab/phosphor-solid/chart-bar";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Instrumentation",
  componentName: "Instrumentation",
  title: "Instrumentation",
  minWidth: 360,
  minHeight: 240,
  icon: ChartBarIcon,
  loadComponent: () => import("./instrumentation-panel"),
  showInPalette: true,
  singleton: "singleton",
});
