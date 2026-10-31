// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup } from "solid-js";
import { panelDefinitionByName } from "../../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import { NETWORK_INTERFACE_SETTING } from "../../../state/settings-request";
import { registerToastActionHandler } from "../../../state/toast-actions";
import { ToastAction } from "../../../types";
import { useAppShell } from "../../providers/app-shell";

/** Connects the follow-ups engine toasts offer to the shell's settings dialog and panels. */
export default function ToastActionsBridge() {
  const shell = useAppShell();
  const unregister = [
    registerToastActionHandler(ToastAction.OpenNetworkSettings, () =>
      shell.openSettings({
        tab: "network",
        setting: NETWORK_INTERFACE_SETTING,
      }),
    ),
    registerToastActionHandler(ToastAction.OpenExternalControlSettings, () =>
      openOrFocusPanelDefinition(
        shell.dockviewApi(),
        panelDefinitionByName("IoTransports"),
      ),
    ),
  ];
  onCleanup(() => {
    for (const remove of unregister) remove();
  });
  return null;
}
