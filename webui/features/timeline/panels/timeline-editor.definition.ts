// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FilmSlateIcon } from "@squidlab/phosphor-solid/film-slate";
import { RENDER_PROPERTIES_CAPABILITY } from "../../../lib/panel-capabilities";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-Timeline",
  componentName: "Timeline",
  title: "Timeline",
  minWidth: 640,
  minHeight: 240,
  icon: FilmSlateIcon,
  loadComponent: () => import("./timeline-editor"),
  capabilities: [RENDER_PROPERTIES_CAPABILITY.id],
  showInPalette: false,
  singleton: "singleton",
});
