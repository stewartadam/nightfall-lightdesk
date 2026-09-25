// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, type JSX } from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import type * as types from "../../../types";
import { behaviorLabel } from "../model/binding-behaviors";

/** Chooses how a new mapping's control invokes its action, among the action's behaviors. */
export function BehaviorSelect(props: {
  /** Currently selected behavior. */
  value: types.ControlBehavior;
  /** Behaviors the chosen action supports. */
  behaviors: types.ControlBehavior[];
  /** Input kind of the chosen action, used to phrase labels. */
  inputKind: types.ActionInputKind | undefined;
  /** Receives the newly selected behavior. */
  onChange: (behavior: types.ControlBehavior) => void;
}): JSX.Element {
  return (
    <NativeSelect
      density="compact"
      aria-label="Behavior"
      value={props.value}
      disabled={props.behaviors.length < 2}
      onChange={(event) =>
        props.onChange(event.currentTarget.value as types.ControlBehavior)
      }
    >
      <For each={props.behaviors}>
        {(behavior) => (
          <option value={behavior}>
            {behaviorLabel(behavior, props.inputKind)}
          </option>
        )}
      </For>
    </NativeSelect>
  );
}
