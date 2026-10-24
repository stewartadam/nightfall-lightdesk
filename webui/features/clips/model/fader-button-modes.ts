// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FaderButtonMode } from "../../../types";

/** Display text for one fader button mode. */
export interface FaderButtonModeText {
  /** Short label shown on the fader's button. */
  label: string;
  /** One-line explanation shown in the mode picker and the button's tooltip. */
  description: string;
}

/** Labels and descriptions for every button mode the backend offers. */
export const FADER_BUTTON_MODE_TEXT: Record<
  FaderButtonMode,
  FaderButtonModeText
> = {
  [FaderButtonMode.Go]: {
    label: "Go",
    description: "Start or advance the clip, or toggle the master",
  },
  [FaderButtonMode.GoBack]: {
    label: "Back",
    description: "Step the running sequence back one cue",
  },
  [FaderButtonMode.Flash]: {
    label: "Flash",
    description: "Play the clip at full while held, or push the master to full",
  },
  [FaderButtonMode.Swop]: {
    label: "Swop",
    description:
      "Play the clip at full and take out every other playback while held",
  },
  [FaderButtonMode.Toggle]: {
    label: "Toggle",
    description: "Start the clip, or stop it if it is running",
  },
  [FaderButtonMode.Release]: {
    label: "Release",
    description: "Stop the running clip",
  },
};
