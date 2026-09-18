// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-CueEditor",
  componentName: "CueEditor",
  title: "Cue Editor",
  minWidth: 360,
  minHeight: 240,
  icon: PencilSimpleLineIcon,
  loadComponent: () => import("./cue-editor-panel"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id],
  showInPalette: false,
  singleton: "singleton",
});
