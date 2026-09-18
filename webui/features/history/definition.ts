// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { definePanel } from "../../lib/panel-module";

export default definePanel({
  panelId: "panel-UndoStack",
  componentName: "UndoStack",
  title: "Undo Stack",
  minWidth: 220,
  minHeight: 160,
  icon: ArrowUUpLeftIcon,
  loadComponent: () => import("./panel"),
  showInPalette: true,
  singleton: "singleton",
});
