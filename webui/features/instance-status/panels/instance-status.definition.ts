// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MonitorPlayIcon } from "@squidlab/phosphor-solid/monitor-play";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-StatusDisplay",
  componentName: "StatusDisplay",
  title: "Status Display",
  minWidth: 220,
  minHeight: 160,
  icon: MonitorPlayIcon,
  loadComponent: () => import("./instance-status-panel"),
  showInPalette: true,
  singleton: "singleton",
});
