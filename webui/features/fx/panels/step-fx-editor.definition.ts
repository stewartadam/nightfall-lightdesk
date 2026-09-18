// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ListDashesIcon } from "@squidlab/phosphor-solid/list-dashes";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-StepFxEditor",
  componentName: "StepFxEditor",
  title: "Step FX Editor",
  minWidth: 480,
  minHeight: 300,
  icon: ListDashesIcon,
  loadComponent: () => import("./step-fx-editor-panel"),
  showInPalette: false,
  singleton: "singleton",
});
