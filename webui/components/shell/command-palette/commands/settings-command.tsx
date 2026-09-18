// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { GearIcon } from "@squidlab/phosphor-solid/gear";
import { onCleanup, onMount } from "solid-js";
import { getLogger } from "../../../../lib/logger";
import { useAppShell } from "../../../providers/app-shell";
import { useCommand } from "../../../providers/command-registry";

const log = getLogger(import.meta.url);

export default function SettingsCommand() {
  const { openSettings } = useAppShell();

  onMount(() => {
    log.trace("mounting");
    useCommand({
      id: "open.settings",
      name: "Open Settings",
      description: "Open application settings",
      icon: GearIcon,
      shortcut: "$mod+,",
      shortcutOptions: {
        allowInEditable: true,
        capture: true,
      },
      execute: () => {
        openSettings();
      },
    });
  });

  onCleanup(() => {
    log.trace("unmounting");
  });

  return null;
}
