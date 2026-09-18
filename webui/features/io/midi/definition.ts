// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PianoKeysIcon } from "@squidlab/phosphor-solid/piano-keys";
import { definePanel } from "../../../lib/panel-module";

export default definePanel({
  panelId: "panel-MidiInput",
  componentName: "MidiInput",
  title: "MIDI Input",
  minWidth: 220,
  minHeight: 160,
  icon: PianoKeysIcon,
  loadComponent: () => import("./panel"),
  showInPalette: true,
  singleton: "singleton",
});
