// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { actionCatalog, pushToast } from "../../../state/appStores";
import * as types from "../../../types";
import { actionInputKind, actionReferenceAllowsSurface } from "../../actions";
import { behaviorLabel } from "./binding-behaviors";
import {
  midiMappingFromEvent,
  midiSourceLabel,
  oscBindingProblem,
  oscMappingFromGesture,
} from "./controller-mapping-builders";
import {
  replacedMappingLabels,
  upsertMidiMapping,
  upsertOscMapping,
} from "./controller-mappings";
import {
  $mappingMode,
  type ArmedSource,
  describeArmedSource,
  disarmMappingSource,
} from "./mapping-mode";
import {
  type DescribedMapping,
  formatBindConfirmation,
} from "./mapping-replacements";

/** Returns the action surface a binding from the armed control invokes through. */
function armedSourceSurface(armed: ArmedSource): types.ActionSurface {
  return armed.kind === "midi"
    ? types.ActionSurface.Midi
    : types.ActionSurface.Osc;
}

/** Returns whether the armed control's surface may bind the action at all. */
function armedSourceAllows(
  armed: ArmedSource,
  action: types.ActionReference,
): boolean {
  return actionReferenceAllowsSurface(
    actionCatalog.get(),
    action,
    armedSourceSurface(armed),
  );
}

/**
 * Explains in plain language why the armed control cannot bind an action with a behavior.
 *
 * The action must allow the control's surface. MIDI controls send levels and report
 * releases, so they can drive every behavior; an OSC control's explanation is phrased from
 * what it sent. Returns undefined when the binding can work.
 */
export function armedBindingProblem(
  armed: ArmedSource,
  action: types.ActionReference,
  behavior: types.ControlBehavior,
  actionLabel: string,
): string | undefined {
  if (!armedSourceAllows(armed, action)) {
    return `${actionLabel} cannot be bound to a ${armed.kind === "midi" ? "MIDI" : "OSC"} control.`;
  }
  if (armed.kind === "midi") return undefined;
  return oscBindingProblem(
    armed,
    action,
    actionInputKind(actionCatalog.get(), action),
    behavior,
    actionLabel,
  );
}

/** Returns whether the armed control can bind an action with a behavior. */
export function armedSourceSupports(
  armed: ArmedSource,
  action: types.ActionReference,
  behavior: types.ControlBehavior,
): boolean {
  return armedBindingProblem(armed, action, behavior, action.id) === undefined;
}

/**
 * Binds the armed MIDI or OSC control to an action with a behavior.
 *
 * `actionLabel` describes the action in the confirmation toast, which also names any
 * bindings on the control that the new one replaced. A stored binding disarms the control,
 * so the next click cannot silently rebind it. Returns whether a mapping was
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
  const problem = armedBindingProblem(armed, action, behavior, actionLabel);
  if (problem) {
    pushToast("info", problem);
    return false;
  }
  const inputKind = actionInputKind(actionCatalog.get(), action);
  let replaced: DescribedMapping[] | null = null;
  if (armed.kind === "osc") {
    replaced = await upsertOscMapping(
      oscMappingFromGesture(armed, action, inputKind, behavior),
    );
  } else {
    const mapping = midiMappingFromEvent(armed.event, action, behavior);
    replaced = mapping ? await upsertMidiMapping(mapping) : null;
  }
  if (replaced === null) return false;
  disarmMappingSource(armed);
  pushToast(
    "success",
    formatBindConfirmation({
      control: describeArmedSource(armed, midiSourceLabel),
      action: actionLabel,
      behavior: behaviorLabel(behavior, inputKind),
      replaced: replacedMappingLabels(replaced),
    }),
  );
  return true;
}
