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
import { playContentEntrance } from "./content-entrance";
import { ScrollArea } from "./scroll-area";
import { Button } from "./visual-language/button";
import "./segmented-tabs.css";

interface SegmentedTabsProps<T extends string> {
  density?: "compact" | "comfortable";
  id: string;
  label: string;
  contentId: string;
  options: readonly { key: T; label: JSX.Element; contentId?: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Selects a content view with roving tab focus and scrolling for narrow horizontal strips. */
export function SegmentedTabs<T extends string>(props: SegmentedTabsProps<T>) {
  const tabs: HTMLButtonElement[] = [];
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
          cancelEntrance = playContentEntrance(panel, {
            direction: nextIndex > previousIndex ? "right" : "left",
          });
        });
        onCleanup(() => {
          cancelAnimationFrame(frame);
          cancelEntrance?.();
        });
      },
    ),
  );

  /** Tracks the selected button's layout so the highlight slides between unequal-width tabs. */
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
              transform: `translateX(${selected.offsetLeft}px)`,
              width: `${selected.offsetWidth}px`,
              top: `${selected.offsetTop}px`,
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

  /** Activates adjacent or endpoint tabs and keeps keyboard focus on the selected option. */
  function navigateTabs(event: KeyboardEvent, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % props.options.length;
        break;
      case "ArrowLeft":
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
              event.currentTarget.scrollIntoView({
                block: "nearest",
                inline: "nearest",
              })
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
