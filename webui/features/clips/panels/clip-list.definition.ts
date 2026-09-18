// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlayCircleIcon } from "@squidlab/phosphor-solid/play-circle";
import {
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
} from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-ClipList",
  componentName: "ClipList",
  title: "Clips",
  minWidth: 515,
  minHeight: 400,
  icon: PlayCircleIcon,
  loadComponent: () => import("./clip-list-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id, REVEAL_OBJECT_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
