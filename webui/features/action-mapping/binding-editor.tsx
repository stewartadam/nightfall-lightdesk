// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { NativeSelect, Textarea } from "../../components/ui/form-controls";
import { actionCatalog } from "../../state/appStores";
import type { ActionReference, ActionSurface } from "../../types";
import { createActionBindingChoices } from "./binding-options";

/** Edits domain bindings from registered metadata and domain-supplied target choices. */
export function ActionBindingEditor(props: {
  surface: ActionSurface;
  value?: ActionReference;
  onChange: (value: ActionReference) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const catalog = useStore(actionCatalog);
  const choices = createActionBindingChoices();
  const [argumentsError, setArgumentsError] = createSignal<string>();
  /** Restricts choices to actions that explicitly support this transport. */
  const available = createMemo(() =>
    catalog().filter((action) =>
      action.allowed_surfaces.includes(props.surface),
    ),
  );
  /** Resolves the current action independently of domain naming conventions. */
  const descriptor = createMemo(() =>
    available().find((action) => action.id === props.value?.id),
  );
  /** Uses the owning domain's persistent target references when provided. */
  const targets = createMemo(() =>
    choices().find((choice) => choice.actionId === props.value?.id),
  );
  /** Keeps a missing/deleted target visibly unresolved instead of selecting a replacement. */
  const selectedTarget = createMemo(() => {
    const provider = targets();
    const reference = props.value;
    const resolved =
      provider && reference ? provider.resolve(reference) : undefined;
    return resolved ? String(provider!.options.indexOf(resolved)) : "";
  });
  /** Parameterless actions need no technical argument editor. */
  const hasArguments = createMemo(() => {
    const schema = descriptor()?.argument_schema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    return Boolean(
      Object.keys(schema?.properties ?? {}).length || schema?.required?.length,
    );
  });
  /** Prevents saving unresolved targets or malformed JSON while retaining the last valid draft. */
  createEffect(() =>
    props.onValidityChange(
      Boolean(descriptor()) &&
        !argumentsError() &&
        (!targets() || selectedTarget() !== ""),
    ),
  );

  return (
    <div class="space-y-2">
      <label class="block text-xs">
        Action
        <NativeSelect
          aria-label="Mapping action"
          value={props.value?.id ?? ""}
          onChange={(event) => {
            setArgumentsError(undefined);
            props.onChange({ id: event.currentTarget.value, arguments: {} });
          }}
        >
          <option value="" disabled>
            {props.value?.id
              ? `Unavailable action: ${props.value.id}`
              : "Choose an action"}
          </option>
          <For each={available()}>
            {(action) => <option value={action.id}>{action.label}</option>}
          </For>
        </NativeSelect>
      </label>
      <Show
        when={targets()}
        fallback={
          <Show when={hasArguments()}>
            <label class="block text-xs">
              Arguments
              <Textarea
                aria-label="Mapping arguments"
                value={JSON.stringify(props.value?.arguments ?? {}, null, 2)}
                onInput={(event) => {
                  try {
                    const args: unknown = JSON.parse(event.currentTarget.value);
                    if (
                      !args ||
                      typeof args !== "object" ||
                      Array.isArray(args)
                    )
                      throw new Error("Arguments must be a JSON object.");
                    setArgumentsError(undefined);
                    if (props.value)
                      props.onChange({ ...props.value, arguments: args });
                  } catch {
                    setArgumentsError(
                      "Enter a valid JSON object for this action's arguments.",
                    );
                  }
                }}
              />
            </label>
          </Show>
        }
      >
        {(provider) => (
          <label class="block text-xs">
            Target
            <NativeSelect
              aria-label="Mapping target"
              value={selectedTarget()}
              onChange={(event) => {
                const selected =
                  provider().options[Number(event.currentTarget.value)];
                if (selected) props.onChange(structuredClone(selected.action));
              }}
            >
              <option value="" disabled>
                Choose an available target
              </option>
              <For each={provider().options}>
                {(option, index) => (
                  <option value={String(index())}>{option.label}</option>
                )}
              </For>
            </NativeSelect>
          </label>
        )}
      </Show>
      <Show when={argumentsError()}>
        {(error) => (
          <p role="alert" class="text-xs text-red-400">
            {error()}
          </p>
        )}
      </Show>
    </div>
  );
}
