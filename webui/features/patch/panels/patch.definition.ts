// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WrenchIcon } from "@squidlab/phosphor-solid/wrench";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-PatchEditor",
  componentName: "PatchEditor",
  title: "Patch",
  minWidth: 360,
  minHeight: 240,
  icon: WrenchIcon,
  loadComponent: () => import("./patch-panel"),
  showInPalette: true,
  singleton: "singleton",
});
