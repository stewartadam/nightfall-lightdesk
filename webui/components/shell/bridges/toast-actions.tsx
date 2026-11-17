// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup } from "solid-js";
import { sendUsbDmxDeviceAssignment } from "../../../lib/io-service";
import { panelDefinitionByName } from "../../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import { NETWORK_INTERFACE_SETTING } from "../../../state/settings-request";
import { registerToastActionHandler } from "../../../state/toast-actions";
import { useAppShell } from "../../providers/app-shell";

/** Connects the follow-ups engine toasts offer to the shell's settings dialog, panels and commands. */
export default function ToastActionsBridge() {
  const shell = useAppShell();
  /** Opens the I/O Transports panel, or focuses it when it is already open. */
  const openIoTransports = () =>
    openOrFocusPanelDefinition(
      shell.dockviewApi(),
      panelDefinitionByName("IoTransports"),
    );
  const unregister = [
    registerToastActionHandler("OpenNetworkSettings", () =>
      shell.openSettings({
        tab: "network",
        setting: NETWORK_INTERFACE_SETTING,
      }),
    ),
    registerToastActionHandler("OpenExternalControlSettings", openIoTransports),
    registerToastActionHandler("OpenUsbDmxOutputs", openIoTransports),
    registerToastActionHandler("UpdateUsbDmxPort", (action) =>
      sendUsbDmxDeviceAssignment(action.data),
    ),
    registerToastActionHandler("ChooseUsbDmxOutput", (action) =>
      sendUsbDmxDeviceAssignment(action.data),
    ),
  ];
  onCleanup(() => {
    for (const remove of unregister) remove();
  });
  return null;
}
