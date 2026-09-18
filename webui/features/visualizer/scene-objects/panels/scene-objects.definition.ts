// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { REVEAL_OBJECT_CAPABILITY } from "../../../../lib/panel-capabilities";
import { definePanel } from "../../../../lib/panel-module";

export default definePanel({
  panelId: "panel-SceneObjects",
  componentName: "SceneObjects",
  title: "Scene Objects",
  minWidth: 515,
  minHeight: 160,
  icon: CubeIcon,
  loadComponent: () => import("./scene-objects-panel"),
  capabilities: [REVEAL_OBJECT_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
