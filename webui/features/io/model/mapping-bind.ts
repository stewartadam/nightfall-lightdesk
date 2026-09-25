// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { actionCatalog, pushToast } from "../../../state/appStores";
import * as types from "../../../types";
import { actionInputKind } from "../../actions";
import {
  midiMappingFromEvent,
  midiSourceLabel,
  oscMappingFromGesture,
  oscMappingReportsRelease,
} from "./controller-mapping-builders";
import { upsertMidiMapping, upsertOscMapping } from "./controller-mappings";
import { $mappingMode, describeArmedSource } from "./mapping-mode";

/**
 * Binds the selected edge of the armed MIDI or OSC source to an action and reports the result.
 *
 * `actionLabel` describes the action in the confirmation. Returns whether a mapping was
 * stored; without an armed source the user is told to move a control first, and an OSC
 * release binding needs a touch that reported its release value.
 */
export async function bindArmedSource(
  action: types.ActionReference,
  actionLabel: string,
): Promise<boolean> {
  const { armed, edge } = $mappingMode.get();
  if (!armed) {
    pushToast("info", "Move a MIDI or OSC control first, then click here.");
    return false;
  }
  const onRelease = edge === types.SourceEdge.Release;
  let stored = false;
  if (armed.kind === "osc") {
    const mapping = oscMappingFromGesture(
      armed,
      action,
      actionInputKind(actionCatalog.get(), action),
      edge,
    );
    if (onRelease && !oscMappingReportsRelease(mapping)) {
      pushToast(
        "info",
        "Press and release the OSC control so its release can be recorded, then click here.",
      );
      return false;
    }
    stored = await upsertOscMapping(mapping);
  } else {
    const mapping = midiMappingFromEvent(armed.event, action, edge);
    stored = mapping ? await upsertMidiMapping(mapping) : false;
  }
  if (stored) {
    const source = describeArmedSource(armed, midiSourceLabel);
    pushToast(
      "success",
      `Mapped ${onRelease ? `release of ${source}` : source} to ${actionLabel}`,
    );
  }
  return stored;
}
