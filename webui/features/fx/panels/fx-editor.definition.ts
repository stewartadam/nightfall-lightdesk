// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WaveSineIcon } from "@squidlab/phosphor-solid/wave-sine";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-FxEditor",
  componentName: "FxEditor",
  title: "FX Editor",
  minWidth: 360,
  minHeight: 240,
  icon: WaveSineIcon,
  loadComponent: () => import("./fx-editor-panel"),
  showInPalette: false,
  singleton: "singleton",
});
