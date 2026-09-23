// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createMemo, Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import type { OscMapping } from "../../../types";
import { oscInputOptionsError } from "./model/input-options";

/** Edits transport-owned conversion without changing the selected domain action. */
export function OscInputOptions(props: {
  mapping: OscMapping;
  onChange: (mapping: OscMapping) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  /** Exposes the backend-representable range error alongside the edited fields. */
  const error = createMemo(() => oscInputOptionsError(props.mapping));
  /** Prevents invalid argument indices and ranges from being submitted by the enclosing editor. */
  createEffect(() => props.onValidityChange(!error()));
  /** Updates one endpoint while retaining the other endpoint and the selected argument. */
  function updateRange(endpoint: "minimum" | "maximum", value: number) {
    const input = props.mapping.input;
    if (input.type !== "Continuous") return;
    props.onChange({
      ...props.mapping,
      input: { type: "Continuous", data: { ...input.data, [endpoint]: value } },
    });
  }
  return (
    <div class="space-y-2">
      <Show when={props.mapping.input.type !== "Continuous"}>
        <label class="block text-xs">
          Activation
          <NativeSelect
            aria-label="OSC activation"
            value={props.mapping.input.type}
            onChange={(event) => {
              const type = event.currentTarget.value;
              if (type === "Press" || type === "Release" || type === "Pulse")
                props.onChange({
                  ...props.mapping,
                  input: { type },
                  arg_index:
                    type === "Pulse" ? undefined : props.mapping.arg_index,
                });
            }}
          >
            <option value="Press">Button press</option>
            <option value="Release">Button release</option>
            <option value="Pulse">Every message (pulse)</option>
          </NativeSelect>
        </label>
      </Show>
      <Show when={props.mapping.input.type !== "Pulse"}>
        <label class="block text-xs">
          Value argument (0-based)
          <Input
            type="number"
            min="0"
            max="255"
            step="1"
            aria-label="OSC value argument"
            value={
              Number.isFinite(props.mapping.arg_index ?? 0)
                ? (props.mapping.arg_index ?? 0)
                : ""
            }
            onInput={(event) =>
              props.onChange({
                ...props.mapping,
                arg_index: event.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
      </Show>
      <Show
        when={
          props.mapping.input.type === "Continuous"
            ? props.mapping.input.data
            : undefined
        }
      >
        {(range) => (
          <div class="grid grid-cols-2 gap-2">
            <label class="block text-xs">
              Source minimum
              <Input
                type="number"
                step="any"
                aria-label="OSC source minimum"
                value={Number.isFinite(range().minimum) ? range().minimum : ""}
                onInput={(event) =>
                  updateRange("minimum", event.currentTarget.valueAsNumber)
                }
              />
            </label>
            <label class="block text-xs">
              Source maximum
              <Input
                type="number"
                step="any"
                aria-label="OSC source maximum"
                value={Number.isFinite(range().maximum) ? range().maximum : ""}
                onInput={(event) =>
                  updateRange("maximum", event.currentTarget.valueAsNumber)
                }
              />
            </label>
            <p class="col-span-2 text-xs text-gray-400">
              The source range maps to the action’s full range. Values outside
              it are clamped.
            </p>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <p role="alert" class="text-xs text-red-400">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
