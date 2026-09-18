// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Attribute editor component for flow nodes.
 * Shows a color swatch representing the attribute value.
 */

import { createMemo } from "solid-js";

export interface AttributeEditorProps {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
}

/**
 * Inline attribute editor for flow node cards.
 * Shows a read-only color swatch.
 */
export function AttributeEditor(props: AttributeEditorProps) {
  const swatchColor = createMemo(() => {
    const next = props.value.toLowerCase();
    if (next === "green") return "#00FF00";
    if (next === "blue") return "#0000FF";
    return "#FF0000"; // red
  });

  return (
    <div class="mt-2 nodrag">
      <div class="mt-2 text-[10px] text-neutral-400 text-center">
        Attribute {props.value}
      </div>
      <div class="mt-2 text-[10px] text-neutral-400 text-left">
        Color: &nbsp;
        <div
          class={`h-4 w-4 rounded-md border border-neutral-700 ${
            props.disabled
              ? "pointer-events-none opacity-60"
              : "cursor-pointer hover:border-neutral-500 transition-colors"
          } inline-block`}
          style={{ "background-color": swatchColor() }}
          title="Edit color in properties panel"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
