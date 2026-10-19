// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, onCleanup } from "solid-js";
import { NAV_COMMAND_LINE_WIDTH } from "../../../features/command-line";

/** Narrowest room the layout switcher keeps before the command input gives way. */
const MIN_LAYOUT_SWITCHER_WIDTH = 240;

interface CommandLineFitElements {
  /** The flexible slot holding the layout switcher, which absorbs leftover header width. */
  switcherSlot: HTMLElement;
  /** The slot holding the command entry, either the full input or its collapsed button. */
  commandSlot: HTMLElement;
}

/**
 * Decides whether the header command input fits on one row beside the layout
 * switcher. It works out how wide the switcher slot would be with the full
 * input shown and collapses the input when that is narrower than the switcher's
 * content (capped at `MIN_LAYOUT_SWITCHER_WIDTH`), so the header never wraps.
 * Measuring against the full input width in both states keeps the decision
 * stable instead of flipping back and forth as the input collapses.
 */
export function createCommandLineFit(): {
  collapsed: Accessor<boolean>;
  observe: (elements: CommandLineFitElements) => void;
} {
  const [collapsed, setCollapsed] = createSignal(false);
  const observer = new ResizeObserver(() => measure());
  let elements: CommandLineFitElements | undefined;

  /** Recomputes the collapsed state from the current slot and switcher content widths. */
  function measure() {
    if (!elements) return;
    const { switcherSlot, commandSlot } = elements;
    const group = switcherSlot.querySelector<HTMLElement>(
      '[aria-label="Layout switcher"]',
    );
    const scroller = group?.firstElementChild as HTMLElement | null;
    const switcherContent =
      group && scroller
        ? group.scrollWidth - scroller.clientWidth + scroller.scrollWidth
        : 0;
    const roomWithFullInput =
      switcherSlot.clientWidth +
      commandSlot.offsetWidth -
      NAV_COMMAND_LINE_WIDTH;
    setCollapsed(
      roomWithFullInput < Math.min(switcherContent, MIN_LAYOUT_SWITCHER_WIDTH),
    );
  }

  /** Starts watching the header slots and the switcher's scrolling strip for size changes. */
  function observe(next: CommandLineFitElements) {
    elements = next;
    observer.observe(next.switcherSlot);
    observer.observe(next.commandSlot);
    const scroller = next.switcherSlot.querySelector<HTMLElement>(
      '[aria-label="Layout switcher"] > :first-child',
    );
    if (scroller) observer.observe(scroller);
    measure();
  }

  onCleanup(() => observer.disconnect());

  return { collapsed, observe };
}
