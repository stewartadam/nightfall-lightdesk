// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Draggable, type DragOptions } from "@neodrag/vanilla";
import { type Accessor, onCleanup, untrack } from "solid-js";
import { createEffect } from "./solid-compat";

export type { DragEventData, DragOptions } from "@neodrag/vanilla";

/**
 * Makes an element draggable with neodrag, as a `ref` callback.
 *
 * `options` is tracked: whenever it changes, the drag instance takes the new
 * options in full, so a controlled `position` or `disabled` flag follows
 * reactive state. neodrag reads its callbacks only once, so they are
 * forwarded to the latest options instead. The instance is destroyed with
 * the owning component.
 *
 * A `ref` callback works on Solid 1.x and 2.0 alike, unlike the `use:`
 * directive that neodrag's Solid adapter needs.
 */
export function draggable(
  options: Accessor<DragOptions>,
): (node: HTMLElement) => void {
  /** Attaches a drag instance to the element and keeps its options current. */
  return (node) => {
    let latest = untrack(options);
    const callbacks: DragOptions = {
      onDragStart: (data) => latest.onDragStart?.(data),
      onDrag: (data) => latest.onDrag?.(data),
      onDragEnd: (data) => latest.onDragEnd?.(data),
    };
    const instance = new Draggable(node, { ...latest, ...callbacks });
    onCleanup(() => instance.destroy());
    /** Hands every later options change to the mounted drag instance. */
    createEffect(
      options,
      (next) => {
        latest = next;
        instance.options = { ...next, ...callbacks };
      },
      { defer: true },
    );
  };
}
