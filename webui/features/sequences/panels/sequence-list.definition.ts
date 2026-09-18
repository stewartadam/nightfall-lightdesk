// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { QueueIcon } from "@squidlab/phosphor-solid/queue";
import {
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
} from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-SequenceList",
  componentName: "SequenceList",
  title: "Sequences",
  minWidth: 515,
  minHeight: 160,
  icon: QueueIcon,
  loadComponent: () => import("./sequence-list-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id, REVEAL_OBJECT_CAPABILITY.id],
  showInPalette: true,
  singleton: "singleton",
});
