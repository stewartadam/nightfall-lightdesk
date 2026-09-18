// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { NativeSelect } from "../../../../components/ui/form-controls";
/**
 * Enum editor component for flow nodes.
 * Renders a dropdown select for ports with enum options.
 */

import { createEffect, createSignal, For } from "solid-js";
import type { FlowPortDefinition } from "../../../../types/index";

export interface EnumEditorProps {
  value: number;
  port: FlowPortDefinition;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/**
 * Dropdown editor for enum (int with options) ports.
 */
export function EnumEditor(props: EnumEditorProps) {
  const [localValue, setLocalValue] = createSignal(props.value);

  createEffect(() => {
    setLocalValue(props.value);
  });

  const handleChange = (value: number) => {
    setLocalValue(value);
    props.onCommit(value);
  };

  return (
    <div class="flex flex-col gap-1">
      <NativeSelect
        density="compact"
        value={localValue()}
        onChange={(e) =>
          handleChange(Number.parseInt(e.currentTarget.value, 10))
        }
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={props.disabled}
        class="w-[140px] nodrag"
      >
        <For each={props.port.enum_options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </NativeSelect>
    </div>
  );
}
