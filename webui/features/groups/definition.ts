// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TagIcon } from "@squidlab/phosphor-solid/tag";
import {
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
} from "../../lib/panel-capabilities";
import { definePanel } from "../../lib/panel-module";

export default definePanel({
  panelId: "panel-Groups",
  componentName: "GroupsPanel",
  title: "Groups",
  minWidth: 515,
  minHeight: 160,
  icon: TagIcon,
  loadComponent: () => import("./panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id, REVEAL_OBJECT_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
