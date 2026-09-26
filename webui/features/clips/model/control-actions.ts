// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import { defineEngineControl, type EngineControl } from "../../actions";

/**
 * Defines a control slot's Go button: clicking it and a controller bound to it both run the
 * slot's backend-owned Go, which follows whatever is assigned to the slot.
 */
export function controlGoControl(
  controlIndex: number,
  send: (command: types.ControlCommand) => unknown,
): EngineControl<{ go: () => void }> {
  return defineEngineControl({
    id: "control.go",
    label: `Go control ${controlIndex}`,
    args: { control_index: controlIndex },
    handlers: (args) => ({
      go: () => void send({ type: "Go", data: args }),
    }),
  });
}

/**
 * Defines a control slot's fader.
 *
 * Dragging the on-screen fader sets the slot's console value, while a bound hardware fader
 * sets its hardware value with soft pickup; both address the same slot.
 */
export function controlFaderControl(
  controlIndex: number,
  send: (update: types.ControlUpdate) => unknown,
): EngineControl<{ setConsoleValue: (value: number) => void }> {
  return defineEngineControl({
    id: "control.level",
    label: `Fader slot ${controlIndex}`,
    args: { control_index: controlIndex },
    handlers: (args) => ({
      setConsoleValue: (value: number) =>
        void send({ type: "SetConsoleValue", data: { ...args, value } }),
    }),
  });
}
