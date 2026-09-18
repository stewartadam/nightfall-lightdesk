// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TerminalWindowIcon } from "@squidlab/phosphor-solid/terminal-window";
import { definePanel } from "../../../lib/panel-module";

export const COMMAND_LINE_PANEL_SHORTCUT = "Shift+`";

export default definePanel({
  panelId: "panel-CommandLine",
  componentName: "CommandLine",
  title: "Console",
  minWidth: 320,
  minHeight: 100,
  icon: TerminalWindowIcon,
  loadComponent: () => import("./command-line-panel"),
  showInPalette: true,
  singleton: "singleton",
  shortcut: COMMAND_LINE_PANEL_SHORTCUT,
});
