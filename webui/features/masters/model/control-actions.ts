// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";
import { defineEngineControl, type EngineControl } from "../../actions";
import { buildToggleMasterCommand } from "./master-model";

/** How the UI streams and commits a dragged master level. */
export interface MasterLevelOperations {
  /** Streams a level while dragging, without undo history. */
  drag: (master: types.Master, levelPercent: number) => void;
  /** Commits the released level as one undoable change. */
  commit: (master: types.Master, levelPercent: number) => void;
}

/**
 * Defines a master's level slider.
 *
 * Bindings address the master by UID so they survive renumbering; the slider operates the
 * same master object the UID was read from.
 */
export function masterLevelControl(
  master: types.Master,
  label: string,
  operations?: MasterLevelOperations,
): EngineControl<{
  drag: (levelPercent: number) => void;
  commit: (levelPercent: number) => void;
}> {
  return defineEngineControl({
    id: "master.level",
    label,
    args: { master: master.identifiers.uid },
    handlers: () => ({
      drag: (levelPercent: number) => operations?.drag(master, levelPercent),
      commit: (levelPercent: number) =>
        operations?.commit(master, levelPercent),
    }),
  });
}

/**
 * Defines a toggle master's Toggle button, which also binds on a control's press or release.
 */
export function masterToggleControl(
  master: types.Master,
  send: (command: types.MasterCommand) => unknown,
): EngineControl<{ toggle: () => void }> {
  return defineEngineControl({
    id: "master.toggle",
    label: "Toggle",
    args: { master: master.identifiers.uid },
    behaviors: [types.ControlBehavior.Press, types.ControlBehavior.Release],
    handlers: () => ({
      toggle: () => void send(buildToggleMasterCommand(master.identifiers.id)),
    }),
  });
}

/**
 * Defines the mapping-only choice that keeps a toggle master on while a control is held,
 * turning it off on release.
 */
export function masterHoldControl(master: types.Master): EngineControl {
  return defineEngineControl({
    id: "master.on",
    label: "On while held",
    args: { master: master.identifiers.uid },
    behaviors: [types.ControlBehavior.Hold],
  });
}
