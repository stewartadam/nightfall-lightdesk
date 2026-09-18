// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-ObjectLibrary",
  componentName: "ObjectLibrary",
  title: "Object Library",
  minWidth: 360,
  minHeight: 240,
  icon: CubeIcon,
  loadComponent: () => import("./object-library-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
