// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { actionCatalog, pushToast } from "../../../state/appStores";
import * as types from "../../../types";
import { actionInputKind } from "../../actions";
import { behaviorLabel } from "./binding-behaviors";
import {
  midiMappingFromEvent,
  midiSourceLabel,
  oscMappingFromGesture,
  oscMappingReportsRelease,
} from "./controller-mapping-builders";
import { upsertMidiMapping, upsertOscMapping } from "./controller-mappings";
import {
  $mappingMode,
  type ArmedSource,
  describeArmedSource,
  disarmMappingSource,
} from "./mapping-mode";

/**
 * Returns whether an armed control can report the releases a behavior needs.
 *
 * MIDI controls always report releases; OSC controls do when their touch recorded a release
 * value or reads an argument as a level or boolean.
 */
export function armedSourceSupports(
  armed: ArmedSource,
  action: types.ActionReference,
  behavior: types.ControlBehavior,
): boolean {
  if (behavior === types.ControlBehavior.Press || armed.kind === "midi") {
    return true;
  }
  return oscMappingReportsRelease(
    oscMappingFromGesture(
      armed,
      action,
      actionInputKind(actionCatalog.get(), action),
      behavior,
    ),
  );
}

/**
 * Binds the armed MIDI or OSC control to an action with a behavior.
 *
 * `actionLabel` describes the action in the confirmation toast. A stored binding disarms
 * the control, so the next click cannot silently rebind it. Returns whether a mapping was
 * stored; without an armed control the user is told to move one first.
 */
export async function bindArmedSource(
  action: types.ActionReference,
  actionLabel: string,
  behavior: types.ControlBehavior = types.ControlBehavior.Press,
): Promise<boolean> {
  const { armed } = $mappingMode.get();
  if (!armed) {
    pushToast("info", "Move a MIDI or OSC control first, then click here.");
    return false;
  }
  const inputKind = actionInputKind(actionCatalog.get(), action);
  let stored = false;
  if (armed.kind === "osc") {
    if (!armedSourceSupports(armed, action, behavior)) {
      pushToast(
        "info",
        "Press and release the OSC control so its release can be recorded, then click here.",
      );
      return false;
    }
    stored = await upsertOscMapping(
      oscMappingFromGesture(armed, action, inputKind, behavior),
    );
  } else {
    const mapping = midiMappingFromEvent(armed.event, action, behavior);
    stored = mapping ? await upsertMidiMapping(mapping) : false;
  }
  if (stored) {
    disarmMappingSource();
    pushToast(
      "success",
      `Bound ${describeArmedSource(armed, midiSourceLabel)} → ${actionLabel} · ${behaviorLabel(behavior, inputKind)}`,
    );
  }
  return stored;
}
