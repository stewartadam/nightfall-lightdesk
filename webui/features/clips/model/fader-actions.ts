// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import { defineEngineControl, type EngineControl } from "../../actions";

/**
 * Defines a fader's button: pressing and releasing it on screen and on a controller
 * bound to it both reach the fader's backend-owned button mode, so they always behave the same.
 */
export function faderButtonControl(
  faderIndex: number,
  send: (command: types.FaderCommand) => unknown,
): EngineControl<{ press: () => void; release: () => void }> {
  return defineEngineControl({
    id: "fader.button",
    label: `Button of fader ${faderIndex}`,
    args: { fader_index: faderIndex },
    handlers: (args) => ({
      press: () => void send({ type: "PressButton", data: args }),
      release: () => void send({ type: "ReleaseButton", data: args }),
    }),
  });
}

/**
 * Defines a mapping-only choice that always runs the fader's Go, whatever its button mode,
 * for controllers that want a dedicated Go next to the fader's button.
 */
export function faderGoControl(faderIndex: number): EngineControl {
  return defineEngineControl({
    id: "fader.go",
    label: `Go fader ${faderIndex}`,
    args: { fader_index: faderIndex },
  });
}

/**
 * Defines a fader's level.
 *
 * Dragging the on-screen fader sets the fader's console value, while a bound hardware fader
 * sets its hardware value with soft pickup; both address the same fader.
 */
export function faderLevelControl(
  faderIndex: number,
  send: (update: types.FaderUpdate) => unknown,
): EngineControl<{ setConsoleValue: (value: number) => void }> {
  return defineEngineControl({
    id: "fader.level",
    label: `Fader ${faderIndex}`,
    args: { fader_index: faderIndex },
    handlers: (args) => ({
      setConsoleValue: (value: number) =>
        void send({ type: "SetConsoleValue", data: { ...args, value } }),
    }),
  });
}
