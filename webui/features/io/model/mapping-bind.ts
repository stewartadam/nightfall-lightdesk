// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  midiMappingFromEvent,
  midiSourceLabel,
  oscMappingFromEvent,
  upsertMidiMapping,
  upsertOscMapping,
} from "./controller-mappings";
import { $mappingMode, describeArmedSource } from "./mapping-mode";

/**
 * Binds the armed MIDI or OSC source to an action and reports the result as a toast.
 *
 * `actionLabel` describes the action in the confirmation. Returns whether a mapping was
 * stored; without an armed source the user is told to move a control first.
 */
export async function bindArmedSource(
  action: types.ActionReference,
  actionLabel: string,
): Promise<boolean> {
  const armed = $mappingMode.get().armed;
  if (!armed) {
    pushToast("info", "Move a MIDI or OSC control first, then click here.");
    return false;
  }
  let stored = false;
  if (armed.kind === "osc") {
    stored = await upsertOscMapping(oscMappingFromEvent(armed.event, action));
  } else {
    const mapping = midiMappingFromEvent(armed.event, action);
    stored = mapping ? await upsertMidiMapping(mapping) : false;
  }
  if (stored) {
    pushToast(
      "success",
      `Mapped ${describeArmedSource(armed, midiSourceLabel)} to ${actionLabel}`,
    );
  }
  return stored;
}
