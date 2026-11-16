// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { onCleanup } from "solid-js";

/** Callbacks for one mouse drag tracked across the whole window. */
export interface WindowMouseDragHandlers {
  /** Called for every mouse move while the drag is active. */
  move: (event: MouseEvent) => void;
  /** Called once when the mouse button is released, after the listeners are removed. */
  end: (event: MouseEvent) => void;
}

/** Controls for a window mouse drag created by {@link createWindowMouseDrag}. */
export interface WindowMouseDrag {
  /** Starts listening for moves and the release, replacing any drag still in progress. */
  start: () => void;
  /** Stops listening without calling `end`, abandoning the drag. */
  cancel: () => void;
}

/**
 * Tracks a mouse drag that keeps following the pointer outside the element it started on.
 * The move and release listeners live on `target` (the window by default) only while a drag is
 * active, and are removed when the owning component is disposed, so a panel that closes
 * mid-drag never receives the release later.
 */
export function createWindowMouseDrag(
  handlers: WindowMouseDragHandlers,
  target: EventTarget = window,
): WindowMouseDrag {
  let active = false;

  /** Forwards one move event to the drag's handler. */
  const handleMove = (event: Event) => handlers.move(event as MouseEvent);

  /** Ends the drag on release: removes the listeners, then reports the final position. */
  const handleUp = (event: Event) => {
    cancel();
    handlers.end(event as MouseEvent);
  };

  /** Removes the drag's listeners if a drag is active. */
  const cancel = () => {
    if (!active) return;
    active = false;
    target.removeEventListener("mousemove", handleMove);
    target.removeEventListener("mouseup", handleUp);
  };

  /** Adds the drag's listeners, dropping any earlier drag first so listeners never stack. */
  const start = () => {
    cancel();
    active = true;
    target.addEventListener("mousemove", handleMove);
    target.addEventListener("mouseup", handleUp);
  };

  onCleanup(cancel);

  return { start, cancel };
}
