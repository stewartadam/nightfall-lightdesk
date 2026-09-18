// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { HandTapIcon } from "@squidlab/phosphor-solid/hand-tap";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-TapPattern",
  componentName: "TapPattern",
  title: "Tap Pattern",
  minWidth: 220,
  minHeight: 160,
  icon: HandTapIcon,
  loadComponent: () => import("./tap-pattern-panel"),
  showInPalette: true,
  singleton: "singleton",
});
