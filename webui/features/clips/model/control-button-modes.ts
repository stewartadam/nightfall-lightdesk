// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ControlButtonMode } from "../../../types";

/** Display text for one control slot button mode. */
export interface ControlButtonModeText {
  /** Short label shown on the slot's button. */
  label: string;
  /** One-line explanation shown in the mode picker and the button's tooltip. */
  description: string;
}

/** Labels and descriptions for every button mode the backend offers. */
export const CONTROL_BUTTON_MODE_TEXT: Record<
  ControlButtonMode,
  ControlButtonModeText
> = {
  [ControlButtonMode.Go]: {
    label: "Go",
    description: "Start or advance the clip, or toggle the master",
  },
  [ControlButtonMode.GoBack]: {
    label: "Back",
    description: "Step the running sequence back one cue",
  },
  [ControlButtonMode.Toggle]: {
    label: "Toggle",
    description: "Start the clip, or stop it if it is running",
  },
  [ControlButtonMode.Release]: {
    label: "Release",
    description: "Stop the running clip",
  },
};
