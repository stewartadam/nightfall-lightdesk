// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";

/** Behaviors offered when an action is missing from the catalog, such as a stale binding. */
const FALLBACK_BEHAVIORS = [types.ControlBehavior.Press];

/** Returns the controller behaviors an action supports, from its catalog entry. */
export function actionBehaviors(
  entry: types.ActionCatalogEntry | undefined,
): types.ControlBehavior[] {
  return entry?.behaviors.length ? entry.behaviors : FALLBACK_BEHAVIORS;
}

/**
 * Picks the binding a touched control most likely means, among those it can bind.
 *
 * Follows the operator's usual intent rather than asking: a fader follows an absolute
 * action ("use the slider"), and a button fires a trigger on press ("button on"). Release,
 * Hold, and Flash stay one click away for operators who want them.
 */
export function recommendedBinding<
  T extends {
    behavior: types.ControlBehavior;
    inputKind: types.ActionInputKind | undefined;
  },
>(options: readonly T[], continuous: boolean): T | undefined {
  const onPress = options.filter(
    (option) => option.behavior === types.ControlBehavior.Press,
  );
  return (
    onPress.find(
      (option) =>
        (option.inputKind === types.ActionInputKind.Absolute) === continuous,
    ) ??
    onPress[0] ??
    options[0]
  );
}

/** Returns the short label for a behavior, phrased for the action's input kind. */
export function behaviorLabel(
  behavior: types.ControlBehavior,
  inputKind: types.ActionInputKind | undefined,
): string {
  switch (behavior) {
    case types.ControlBehavior.Press:
      return inputKind === types.ActionInputKind.Absolute
        ? "Follow fader"
        : "On press";
    case types.ControlBehavior.Release:
      return "On release";
    case types.ControlBehavior.Hold:
      return "While held";
    case types.ControlBehavior.Flash:
      return "Flash to full";
  }
}

/** Names used to describe one binding in a sentence. */
export interface BindingDescription {
  /** Control being bound, such as "Pad 60" or "OSC /go". */
  control: string;
  /** Label of the bound action and its target. */
  action: string;
  /** Label of the action a Hold runs on release, when known. */
  releaseAction?: string;
  /** Behavior being bound. */
  behavior: types.ControlBehavior;
  /** Input kind of the bound action. */
  inputKind: types.ActionInputKind | undefined;
}

/** Spells out what a binding does in one plain sentence. */
export function describeBinding(binding: BindingDescription): string {
  const { control, action } = binding;
  switch (binding.behavior) {
    case types.ControlBehavior.Press:
      return binding.inputKind === types.ActionInputKind.Absolute
        ? `Moving ${control} sets ${action}.`
        : `Pressing ${control} runs ${action}.`;
    case types.ControlBehavior.Release:
      return `Releasing ${control} runs ${action}.`;
    case types.ControlBehavior.Hold:
      return `Holding ${control} runs ${action}; letting go runs ${
        binding.releaseAction ?? "its release action"
      }.`;
    case types.ControlBehavior.Flash:
      return `Holding ${control} pushes ${action} to full; letting go restores it.`;
  }
}
