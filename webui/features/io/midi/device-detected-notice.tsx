// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PianoKeysIcon } from "@squidlab/phosphor-solid/piano-keys";
import { onCleanup } from "solid-js";
import { useAppShell } from "../../../components/providers/app-shell";
import { openOrFocusPanelDefinition } from "../../../lib/panel-open-command";
import { midiDetectedDevices } from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import midiPanelDefinition from "./definition";

/** How long the notice stays, longer than plain feedback since it offers a next step. */
const NOTICE_DURATION_MS = 10_000;

/** Joins device names into a readable list, such as "A, B and C". */
function deviceList(devices: readonly string[]): string {
  if (devices.length <= 1) return devices.join("");
  return `${devices.slice(0, -1).join(", ")} and ${devices[devices.length - 1]}`;
}

/**
 * Tells the operator when a MIDI controller the show does not map yet connects while the app
 * runs, and offers to open MIDI settings to map it. The engine decides which devices are new and
 * announces each once, so a controller connected at startup or plugged back in stays quiet. The
 * notice offers "Don't show this again", and Settings turns it back on.
 */
export function MidiDeviceDetectedNotice() {
  const { dockviewApi } = useAppShell();

  // Every announcement is a new value, so listen to the raw store rather than a deduplicated
  // signal.
  const unsubscribe = midiDetectedDevices.listen((devices) => {
    if (devices.length === 0) return;
    const several = devices.length > 1;
    pushToast(
      "info",
      `${deviceList(devices)} ${several ? "are" : "is"} connected. Map ${several ? "their" : "its"} controls to actions in MIDI settings.`,
      NOTICE_DURATION_MS,
      [
        {
          label: "Open MIDI settings",
          onClick: () =>
            openOrFocusPanelDefinition(dockviewApi(), midiPanelDefinition),
        },
      ],
      {
        title: several ? "New MIDI devices" : "New MIDI device",
        icon: PianoKeysIcon,
        dismissablePrompt: "midi-device-detected",
      },
    );
  });
  onCleanup(unsubscribe);

  return null;
}
