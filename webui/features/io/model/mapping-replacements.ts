// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";
import { behaviorLabel } from "./binding-behaviors";

/** The parts of a stored MIDI or OSC mapping needed to describe it. */
export interface DescribedMapping {
  /** Action the mapping invokes. */
  action: types.ActionReference;
  /** How the control's presses and releases invoke the action; absent means a press. */
  behavior?: types.ControlBehavior;
}

/**
 * Describes mappings that an upsert replaced, one label per mapping.
 *
 * Each label names the mapping's action; a behavior other than a plain press is appended so
 * replaced press and release bindings on the same control can be told apart.
 */
export function describeReplacedMappings(
  replaced: readonly DescribedMapping[],
  describeAction: (action: types.ActionReference) => string,
  inputKind: (action: types.ActionReference) => types.ActionInputKind,
): string[] {
  return replaced.map((mapping) => {
    const action = describeAction(mapping.action);
    return mapping.behavior === undefined ||
      mapping.behavior === types.ControlBehavior.Press
      ? action
      : `${action} · ${behaviorLabel(mapping.behavior, inputKind(mapping.action))}`;
  });
}

/** Formats the " (replaced: …)" suffix naming replaced bindings, or nothing when none were. */
export function replacedSuffix(labels: readonly string[]): string {
  return labels.length > 0 ? ` (replaced: ${labels.join(", ")})` : "";
}

/** Parts of the confirmation shown after a control is bound in mapping mode. */
export interface BindConfirmation {
  /** Description of the bound control, such as `OSC /fader/1`. */
  control: string;
  /** Description of the bound action. */
  action: string;
  /** Label of the binding's behavior. */
  behavior: string;
  /** Labels of the bindings the new one replaced. */
  replaced: readonly string[];
}

/** Formats the confirmation toast for a stored binding, naming any bindings it replaced. */
export function formatBindConfirmation(confirmation: BindConfirmation): string {
  const { control, action, behavior, replaced } = confirmation;
  return `Bound ${control} → ${action} · ${behavior}${replacedSuffix(replaced)}`;
}

/** Formats the notice shown when an edit outside mapping mode replaced other bindings. */
export function formatReplacedNotice(labels: readonly string[]): string {
  return `Replaced ${labels.length === 1 ? "mapping" : "mappings"}: ${labels.join(", ")}`;
}
