// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
} from "solid-js";
import { type ContentEntrance, playContentEntrance } from "./content-entrance";
import { ScrollArea } from "./scroll-area";
import { Button } from "./visual-language/button";
import "./segmented.css";
import "./segmented-tabs.css";

/**
 * Scrolls the strip along its axis so a tab is fully visible inside its scroll padding, which
 * keeps the edge indicators from covering it. Only the strip scrolls: unlike
 * `scrollIntoView`, this never moves an enclosing dialog, panel or page. Does nothing when
 * the tab is already visible. The viewport is the tabs' offset parent, so the tab's offsets
 * are in the strip's scroll coordinates.
 */
function revealTab(
  viewport: HTMLElement,
  tab: HTMLElement,
  orientation: TabsOrientation,
) {
  const style = getComputedStyle(viewport);
  if (orientation === "vertical") {
    const padStart = Number.parseFloat(style.scrollPaddingBlockStart) || 0;
    const padEnd = Number.parseFloat(style.scrollPaddingBlockEnd) || 0;
    const start = tab.offsetTop - padStart;
    const end =
      tab.offsetTop + tab.offsetHeight + padEnd - viewport.clientHeight;
    if (viewport.scrollTop > start) viewport.scrollTop = start;
    else if (viewport.scrollTop < end) viewport.scrollTop = end;
    return;
  }
  const padStart = Number.parseFloat(style.scrollPaddingInlineStart) || 0;
  const padEnd = Number.parseFloat(style.scrollPaddingInlineEnd) || 0;
  const start = tab.offsetLeft - padStart;
  const end = tab.offsetLeft + tab.offsetWidth + padEnd - viewport.clientWidth;
  if (viewport.scrollLeft > start) viewport.scrollLeft = start;
  else if (viewport.scrollLeft < end) viewport.scrollLeft = end;
}

/** Axis the tabs are laid out along: a row strip, or a column such as a dialog sidebar. */
export type TabsOrientation = "horizontal" | "vertical";

/**
 * How content enters for each orientation: from the side of the newly selected tab. A vertical
 * slide uses a short distance, since a full-height panel moving its whole height reads as a jump.
 */
const CONTENT_ENTRANCES: Record<
  TabsOrientation,
  { backward: ContentEntrance; forward: ContentEntrance; distance?: number }
> = {
  horizontal: { backward: "left", forward: "right" },
  vertical: { backward: "top", forward: "bottom", distance: 10 },
};

interface SegmentedTabsProps<T extends string> {
  density?: "compact" | "comfortable";
  /** Lays the tabs out in a row (default) or a column; arrow keys follow the same axis. */
  orientation?: TabsOrientation;
  id: string;
  label: string;
  contentId: string;
  options: readonly { key: T; label: JSX.Element; contentId?: string }[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Selects a content view with roving tab focus. Lays out as a horizontal strip that scrolls when
 * narrow, or as a vertical list that scrolls when short.
 */
export function SegmentedTabs<T extends string>(props: SegmentedTabsProps<T>) {
  const tabs: HTMLButtonElement[] = [];
  /** Axis the strip is laid out along, defaulting to a horizontal row. */
  const orientation = (): TabsOrientation => props.orientation ?? "horizontal";
  let viewport!: HTMLDivElement;
  const [indicator, setIndicator] = createSignal<JSX.CSSProperties>();

  /** Slides the associated content into place after a selection change has rendered. */
  createEffect(
    on(
      () => props.value,
      (value, previous) => {
        const nextIndex = props.options.findIndex(
          (option) => option.key === value,
        );
        const previousIndex = props.options.findIndex(
          (option) => option.key === previous,
        );
        if (nextIndex < 0 || previousIndex < 0) return;
        const contentId = props.options[nextIndex].contentId ?? props.contentId;
        let cancelEntrance: (() => void) | undefined;
        const frame = requestAnimationFrame(() => {
          const document = viewport.ownerDocument;
          if (document.documentElement.dataset.reducedMotion === "true") return;
          const panel = document.getElementById(contentId);
          if (!panel) return;
          const { backward, forward, distance } =
            CONTENT_ENTRANCES[orientation()];
          cancelEntrance = playContentEntrance(panel, {
            direction: nextIndex > previousIndex ? forward : backward,
            distance,
          });
        });
        onCleanup(() => {
          cancelAnimationFrame(frame);
          cancelEntrance?.();
        });
      },
    ),
  );

  /**
   * Scrolls the selected tab into view whenever the selection changes, including the initial
   * one, so a tab chosen programmatically (e.g. Settings opened on a specific tab) is not left
   * hidden past the edge of a narrow strip or short list. Waits a frame so the strip has been
   * laid out.
   */
  createEffect(() => {
    const index = props.options.findIndex(
      (option) => option.key === props.value,
    );
    const axis = orientation();
    const frame = requestAnimationFrame(() => {
      const tab = tabs[index];
      if (tab) revealTab(viewport, tab, axis);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });

  /** Tracks the selected button's layout so the highlight slides between unequal-size tabs. */
  createEffect(() => {
    const value = props.value;
    const options = props.options;
    /** Aligns the highlight in scroll-content coordinates, including after resizing or font loading. */
    function measure() {
      const selected = Array.from(
        viewport.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      )[options.findIndex((option) => option.key === value)];
      setIndicator(
        selected
          ? {
              transform: `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`,
              width: `${selected.offsetWidth}px`,
              height: `${selected.offsetHeight}px`,
            }
          : undefined,
      );
    }
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    for (const tab of viewport.querySelectorAll('[role="tab"]')) {
      resize.observe(tab);
    }
    onCleanup(() => resize.disconnect());
  });

  /**
   * Activates adjacent or endpoint tabs and keeps keyboard focus on the selected option. The
   * arrow keys along the strip's axis move the selection (Left/Right for a row, Up/Down for a
   * column), wrapping at either end; the cross-axis arrows are left to the page.
   */
  function navigateTabs(event: KeyboardEvent, index: number) {
    const vertical = orientation() === "vertical";
    let next: number;
    switch (event.key) {
      case vertical ? "ArrowDown" : "ArrowRight":
        next = (index + 1) % props.options.length;
        break;
      case vertical ? "ArrowUp" : "ArrowLeft":
        next = (index + props.options.length - 1) % props.options.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = props.options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    props.onChange(props.options[next].key);
    tabs[next]?.focus();
  }

  return (
    <ScrollArea
      class="nf-segmented-tabs"
      viewportClass="nf-segmented-tabs-viewport"
      viewportProps={{
        "data-density": props.density ?? "comfortable",
        ref: (element) => {
          viewport = element;
        },
        role: "tablist",
        "aria-label": props.label,
        "aria-orientation": orientation(),
      }}
    >
      <span
        class="nf-segmented-tabs-indicator"
        aria-hidden="true"
        style={indicator()}
        hidden={!indicator()}
      />
      <For each={props.options}>
        {(tab, index) => (
          <Button
            ref={(element) => {
              tabs[index()] = element;
            }}
            role="tab"
            id={`${props.id}-${tab.key}`}
            aria-controls={tab.contentId ?? props.contentId}
            aria-selected={props.value === tab.key}
            tabIndex={props.value === tab.key ? 0 : -1}
            onClick={() => props.onChange(tab.key)}
            onFocus={(event) =>
              revealTab(viewport, event.currentTarget, orientation())
            }
            onKeyDown={(event) => navigateTabs(event, index())}
          >
            {tab.label}
          </Button>
        )}
      </For>
    </ScrollArea>
  );
}
