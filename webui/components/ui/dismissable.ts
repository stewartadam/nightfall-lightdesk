// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, onCleanup } from "solid-js";
import {
  type DismissableLayerEntry,
  isInsideLayerAbove,
  registerDismissableLayer,
} from "./modal/dialog-stack";

/** Why a dismissable layer asked to close. */
export type DismissReason = "outside" | "escape";

export interface DismissableOptions {
  /** Whether the layer is open; listeners and the stack entry exist only while it is. */
  active: () => boolean;
  /**
   * Elements that belong to the layer, such as its surface and the anchor that
   * toggles it. Pointer presses inside them are not outside presses.
   */
  refs: () => readonly (Element | null | undefined)[];
  /** Called when the user presses outside the layer or presses Escape. */
  onDismiss: (reason: DismissReason) => void;
  /**
   * Whether Escape dismisses the layer, read on every key press. Defaults to
   * true. With false, Escape passes to the layer or dialog beneath.
   */
  escape?: () => boolean;
  /**
   * Whether a pointer press outside the layer dismisses it. Defaults to true.
   * Turn it off for layers that catch outside presses themselves, such as a
   * context menu with a backdrop.
   */
  outsidePress?: boolean;
}

/**
 * Dismisses a transient floating layer (popover, menu, picker) on a pointer
 * press outside it or on Escape. While `active`, the layer sits on the shared
 * dialog stack above everything opened before it, so Escape closes the
 * topmost popover first, even inside an open modal dialog, without the layer
 * counting as an open dialog. Outside presses are detected with one
 * capture-phase `pointerdown` listener; presses inside a layer or dialog
 * opened on top of this one (a nested popover) do not count as outside.
 */
export function createDismissable(options: DismissableOptions): void {
  /** Registers the layer and its outside-press listener for as long as it stays active. */
  createEffect(() => {
    if (!options.active()) return;

    const entry: DismissableLayerEntry = {
      contains: (target) =>
        options.refs().some((element) => element?.contains(target) === true),
      escapeAction: () =>
        options.escape?.() === false
          ? undefined
          : () => options.onDismiss("escape"),
    };

    /** Dismisses on a press that lands outside the layer and everything stacked above it. */
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (entry.contains(target) || isInsideLayerAbove(entry, target)) return;
      options.onDismiss("outside");
    };

    const unregister = registerDismissableLayer(entry);
    const listensForOutsidePress = options.outsidePress !== false;
    if (listensForOutsidePress) {
      document.addEventListener("pointerdown", handlePointerDown, true);
    }
    onCleanup(() => {
      unregister();
      if (listensForOutsidePress) {
        document.removeEventListener("pointerdown", handlePointerDown, true);
      }
    });
  });
}
