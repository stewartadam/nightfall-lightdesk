// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createContext,
  createMemo,
  type ParentProps,
  useContext,
} from "solid-js";
import type { ActionKind, ActionReference } from "../../types";

/** One ready-to-save binding, supplied by the domain that owns its arguments. */
export interface ActionBindingOption {
  label: string;
  description?: string;
  action: ActionReference;
  /** Optional display projection for existing timeline target links; never used for execution or storage. */
  timelinePresentation?: Exclude<ActionKind, { type: "RegisteredAction" }>;
}

/** Domain-owned choices for an action, independent of any mounted target control. */
export interface ActionBindingChoices {
  actionId: string;
  options: ActionBindingOption[];
  legacyTimelineType?: string;
  /** Resolves saved arguments against current domain state, including identity normalization. */
  resolve: (reference: ActionReference) => ActionBindingOption | undefined;
}

export type ActionBindingChoicesFactory = () => Accessor<
  ActionBindingChoices[]
>;

/** Builds choices for a domain-defined scalar target argument without interpreting action IDs. */
export function buildArgumentTargetChoices(
  actionId: string,
  argumentName: string,
  targets: { label: string; value: string | number }[],
  normalize: (value: string | number) => string | number = (value) => value,
): ActionBindingChoices {
  const options = targets.map((target) => ({
    label: target.label,
    action: {
      id: actionId,
      arguments: { [argumentName]: target.value },
    },
  }));
  const byValue = new Map(
    targets.map((target, index) => [normalize(target.value), options[index]]),
  );
  return {
    actionId,
    options,
    /** Resolves the exact saved domain argument without substituting a different target. */
    resolve(reference) {
      const args = reference.arguments;
      if (
        reference.id !== actionId ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1
      )
        return undefined;
      const value = (args as Record<string, unknown>)[argumentName];
      return typeof value === "string" || typeof value === "number"
        ? byValue.get(normalize(value))
        : undefined;
    },
  };
}
const BindingOptionsContext = createContext<Accessor<ActionBindingChoices[]>>(
  () => [],
);

/** Installs domain choice factories at application composition without coupling the shared catalog to domains. */
export function ActionBindingOptionsProvider(
  props: ParentProps<{ factories: ActionBindingChoicesFactory[] }>,
) {
  const sources = props.factories.map((factory) => factory());
  /** Shares domain subscriptions and computed target lists across all catalog consumers. */
  const choices = createMemo(() => sources.flatMap((read) => read()));
  return (
    <BindingOptionsContext.Provider value={choices}>
      {props.children}
    </BindingOptionsContext.Provider>
  );
}

/** Creates reactive domain choices under the consuming component's lifecycle. */
export function createActionBindingChoices(): Accessor<ActionBindingChoices[]> {
  return useContext(BindingOptionsContext);
}

/** Delegates saved-binding interpretation to its owning domain without matching action names here. */
export function resolveActionBindingOption(
  choices: ActionBindingChoices[],
  reference: ActionReference,
): ActionBindingOption | undefined {
  return choices
    .find((choice) => choice.actionId === reference.id)
    ?.resolve(reference);
}
