// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { defineEngineControl, type EngineControl } from "../../actions";

/**
 * Defines a Clear Programmer button, shared by the programmer toolbar and the command line.
 *
 * `clear` is the surface's own clear, such as clearing the selection before values; a bound
 * controller runs the backend's clear.
 */
export function programmerClearControl(
  clear: () => void,
): EngineControl<{ clear: () => void }> {
  return defineEngineControl({
    id: "programmer.clear",
    label: "Clear programmer",
    args: {},
    handlers: () => ({ clear }),
  });
}
