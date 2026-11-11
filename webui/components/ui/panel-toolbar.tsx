// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DotsThreeIcon } from "@squidlab/phosphor-solid/dots-three";
import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import { createDismissable } from "./dismissable";
import { overlayHost } from "./modal/dialog-stack";
import { ScrollIndicators } from "./scroll-area";
import { ToolbarButton } from "./toolbar-button";
import "./toolbar.css";

interface PanelToolbarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  left?: JSX.Element;
  right?: JSX.Element;
  leftClass?: string;
  rightClass?: string;
  /**
   * Classes for the element that holds the toolbar's place in the panel
   * layout, for positioning such as `sticky`; `class` styles the toolbar.
   */
  frameClass?: string;
  position?: "header" | "footer";
}

/** Whether an element takes typed text, so keys such as Escape act on its contents. */
function isTextEntry(element: Element | null): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    (element instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "range", "submit", "reset"].includes(
        element.type,
      ))
  );
}

/** Measured first row of a wrapping toolbar and the controls that fell past it. */
interface ToolbarRows {
  /** Height the toolbar needs to show only its first row, border included. */
  firstRowHeight: number;
  /** Controls laid out on later rows. */
  overflowed: HTMLElement[];
}

/**
 * Arranges panel actions into shared left and right groups on one row. When
 * the panel is too narrow for every control, the controls that would wrap
 * stay hidden behind a "More actions" button at the end of the row, which
 * unfolds the remaining rows over the panel content. Where the surrounding
 * layout makes the toolbar scroll sideways instead (the compact shell does),
 * caret and blur cues mark the edges that hide more.
 */
export default function PanelToolbar(props: PanelToolbarProps) {
  const [local, rest] = splitProps(props, [
    "left",
    "right",
    "leftClass",
    "rightClass",
    "frameClass",
    "class",
    "position",
    "ref",
  ]);
  const [scrolls, setScrolls] = createSignal(false);
  const [overflowing, setOverflowing] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [firstRowHeight, setFirstRowHeight] = createSignal(0);
  const [edge, setEdge] = createSignal("0 none");
  let frameElement!: HTMLDivElement;
  let toolbar!: HTMLDivElement;
  let moreButton: HTMLButtonElement | undefined;
  let frame: number | undefined;
  const hidden = new Set<HTMLElement>();
  const footer = () => local.position === "footer";

  /** Re-measures once the current layout pass settles, coalescing bursts of changes. */
  function schedule() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      measure();
    });
  }

  /**
   * Splits the wrapped controls into the first row and the rows after it,
   * reading the bottom row first for a footer, whose rows stack upward.
   */
  function readRows(): ToolbarRows {
    const items = [
      ...toolbar.querySelectorAll<HTMLElement>(
        ":scope > .nf-toolbar-group > *",
      ),
    ].filter((item) => item.offsetWidth > 0 || item.offsetHeight > 0);
    const box = toolbar.getBoundingClientRect();
    const style = getComputedStyle(toolbar);
    const rects = items.map((item) => item.getBoundingClientRect());
    if (rects.length === 0)
      return { firstRowHeight: box.height, overflowed: [] };
    // Controls touching the row's outer edge set the band of the first row;
    // a control overlapping that band shares the row, anything past it wraps.
    if (footer()) {
      const edge = Math.max(...rects.map((rect) => rect.bottom));
      const band = Math.max(
        ...rects
          .filter((rect) => rect.bottom >= edge - 1)
          .map((rect) => rect.top),
      );
      const firstRow = rects.filter((rect) => rect.bottom > band);
      const rowTop = Math.min(...firstRow.map((rect) => rect.top));
      return {
        firstRowHeight:
          box.bottom -
          rowTop +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.borderTopWidth),
        overflowed: items.filter((_, index) => rects[index].bottom <= band),
      };
    }
    const edge = Math.min(...rects.map((rect) => rect.top));
    const band = Math.min(
      ...rects
        .filter((rect) => rect.top <= edge + 1)
        .map((rect) => rect.bottom),
    );
    const firstRow = rects.filter((rect) => rect.top < band);
    const rowBottom = Math.max(...firstRow.map((rect) => rect.bottom));
    return {
      firstRowHeight:
        rowBottom -
        box.top +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderBottomWidth),
      overflowed: items.filter((_, index) => rects[index].top >= band),
    };
  }

  /**
   * Shows the "More actions" button while controls wrap past the first row,
   * clips the toolbar to that row, and takes the hidden controls out of the
   * tab order so keyboard users only reach what they can see.
   */
  function measure() {
    if (scrolls() || !toolbar.isConnected) return;
    // Decide without the room reserved for "More actions", so a toolbar folds
    // and unfolds at the same width, then read the rows as they lay out with it.
    frameElement.toggleAttribute("data-measuring", true);
    const wraps = readRows().overflowed.length > 0;
    frameElement.toggleAttribute("data-measuring", false);
    if (wraps) frameElement.setAttribute("data-overflowing", "true");
    else frameElement.removeAttribute("data-overflowing");
    const rows = wraps ? readRows() : { firstRowHeight: 0, overflowed: [] };
    setOverflowing(wraps);
    setFirstRowHeight(rows.firstRowHeight);
    // The toolbar's divider lies past the visible row once it folds, so the
    // frame redraws it from the toolbar's own border.
    const style = getComputedStyle(toolbar);
    const side = footer() ? "Top" : "Bottom";
    setEdge(
      `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`,
    );
    if (!wraps) setExpanded(false);
    // A control that takes focus as it lands on a folded row, such as a
    // search field opening in place of its button, unfolds the rows so the
    // person keeps typing where they can see it.
    const focused = document.activeElement;
    if (
      !expanded() &&
      focused instanceof Node &&
      rows.overflowed.some((item) => item.contains(focused))
    )
      setExpanded(true);
    const hide = new Set(expanded() ? [] : rows.overflowed);
    for (const item of hidden) {
      if (!hide.has(item)) item.inert = false;
    }
    hidden.clear();
    for (const item of hide) {
      item.inert = true;
      hidden.add(item);
    }
  }

  /** Folds the extra rows away, keeping focus on the toolbar when it was inside them. */
  function collapse() {
    const focused = document.activeElement;
    if (
      focused instanceof Node &&
      readRows().overflowed.some((item) => item.contains(focused))
    )
      moreButton?.focus();
    setExpanded(false);
    measure();
  }

  createDismissable({
    active: expanded,
    refs: () => [toolbar, moreButton],
    onDismiss: collapse,
    // Escape in a text field on an unfolded row belongs to that field, and
    // Escape elsewhere in the app belongs to whatever has focus there.
    escape: () => {
      const focused = document.activeElement;
      return (
        focused === document.body ||
        (frameElement.contains(focused) && !isTextEntry(focused))
      );
    },
  });

  /** Folds the extra rows away once keyboard focus moves to another part of the app. */
  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (expanded() && next instanceof Node && !frameElement.contains(next))
      collapse();
  }

  /**
   * Shows scroll cues only for a toolbar styled to scroll. The compact shell
   * remounts panels when the viewport crosses its breakpoint, so reading the
   * style once at mount stays correct, and docked toolbars pay no observer cost.
   */
  onMount(() => {
    const overflow = getComputedStyle(toolbar).overflowX;
    setScrolls(overflow === "auto" || overflow === "scroll");
    if (scrolls()) return;
    const resize = new ResizeObserver(schedule);
    resize.observe(toolbar);
    for (const group of toolbar.querySelectorAll(":scope > .nf-toolbar-group"))
      resize.observe(group);
    const mutations = new MutationObserver(schedule);
    mutations.observe(toolbar, { childList: true, subtree: true });
    measure();
    onCleanup(() => {
      resize.disconnect();
      mutations.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const item of hidden) item.inert = false;
    });
  });

  /** Reveals or hides the extra rows' controls whenever the toolbar unfolds or folds. */
  createEffect(on(expanded, () => measure(), { defer: true }));

  return (
    <>
      <div
        ref={frameElement}
        class={`nf-panel-toolbar-frame ${local.frameClass ?? ""}`}
        onFocusOut={onFocusOut}
        data-overflowing={overflowing() ? "true" : undefined}
        data-expanded={expanded() ? "true" : undefined}
        data-position={local.position}
        style={
          overflowing()
            ? {
                height: `${firstRowHeight()}px`,
                "--nf-toolbar-row": `${firstRowHeight()}px`,
                "--nf-toolbar-edge": edge(),
              }
            : undefined
        }
      >
        <div
          ref={(element) => {
            toolbar = element;
            if (typeof local.ref === "function") local.ref(element);
          }}
          class={`nf-panel-toolbar ${local.class ?? ""}`}
          data-component="PanelToolbar"
          data-position={local.position}
          {...rest}
        >
          <div
            class={`nf-toolbar-group ${local.leftClass ?? ""}`}
            data-slot="left"
          >
            {local.left}
          </div>
          <div
            class={`nf-toolbar-group ${local.rightClass ?? ""}`}
            data-slot="right"
          >
            {local.right}
          </div>
        </div>
        <Show when={overflowing()}>
          <div class="nf-panel-toolbar-more">
            <ToolbarButton
              ref={(element: HTMLButtonElement) => {
                moreButton = element;
              }}
              label={expanded() ? "Fewer actions" : "More actions"}
              aria-expanded={expanded()}
              data-toolbar-more="true"
              onClick={() => (expanded() ? collapse() : setExpanded(true))}
            >
              <DotsThreeIcon class="size-4" weight="bold" aria-hidden />
            </ToolbarButton>
          </div>
        </Show>
      </div>
      <Show when={scrolls()}>
        <Portal mount={overlayHost(toolbar)}>
          <ScrollIndicators
            viewport={toolbar}
            fixed
            class="nf-panel-toolbar-scroll"
          />
        </Portal>
      </Show>
    </>
  );
}

/**
 * Visually separates related action groups without entering the keyboard
 * focus order or the accessibility tree. Extra attributes, such as `data-*`
 * test hooks, pass through to the divider.
 */
export function ToolbarSeparator(
  props: Omit<JSX.HTMLAttributes<HTMLDivElement>, "class" | "children">,
) {
  return <div {...props} class="nf-toolbar-separator" aria-hidden="true" />;
}
