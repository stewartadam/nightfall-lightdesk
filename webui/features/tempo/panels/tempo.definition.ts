// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MetronomeIcon } from "@squidlab/phosphor-solid/metronome";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Tempo",
  componentName: "Tempo",
  title: "Tempo",
  minWidth: 220,
  minHeight: 200,
  icon: MetronomeIcon,
  loadComponent: () => import("./tempo-panel"),
  showInPalette: true,
  singleton: "singleton",
});
