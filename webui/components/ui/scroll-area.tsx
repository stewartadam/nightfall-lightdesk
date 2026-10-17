// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { createSignal, For, type JSX, onCleanup, onMount } from "solid-js";
import "./scroll-area.css";

export interface ScrollAreaProps {
  children: JSX.Element;
  class?: string;
  style?: JSX.CSSProperties | string;
  viewportClass?: string;
  viewportProps?: JSX.HTMLAttributes<HTMLDivElement> & {
    [attribute: `data-${string}`]: string | boolean | undefined;
  };
}

const edges = ["top", "bottom", "left", "right"] as const;

interface ScrollIndicatorsProps {
  viewport: HTMLElement;
  /** Keeps a fixed overlay below a widget's sticky search or heading row. */
  stickyHeader?: HTMLElement | null;
  /** Positions hints over a third-party viewport without changing its DOM or scroll owner. */
  fixed?: boolean;
  /** Extra class for the overlay, such as one that matches the viewport's background. */
  class?: string;
  /**
   * Re-measures when content elements are added or removed or the top-level content boxes
   * resize, but not on attribute or text changes deep in the content. For large, busy hosts such
   * as a whole panel, where live values and animated styles would otherwise trigger a measurement
   * every frame.
   */
  structureOnly?: boolean;
}

/**
 * Observes an existing viewport and decorates only edges with content beyond it. A visible edge
 * owns the pointer, so content beneath its blur cannot be hovered or clicked; clicking the edge
 * scrolls toward it and wheel input over it still scrolls the viewport.
 */
export function ScrollIndicators(props: ScrollIndicatorsProps) {
  const edgeElements: Partial<Record<(typeof edges)[number], HTMLSpanElement>> =
    {};
  const [overflow, setOverflow] = createSignal({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [placement, setPlacement] = createSignal<JSX.CSSProperties>({});

  /** Measures after layout and watches scrolling, resizing, and content changes until unmount. */
  onMount(() => {
    const viewport = props.viewport;
    let frame = 0;
    const observed = new Set<Element>();

    /** Coalesces layout reads and tolerates fractional positions at either scroll endpoint. */
    function measure() {
      frame = 0;
      const {
        scrollTop,
        scrollLeft,
        scrollWidth,
        scrollHeight,
        clientWidth,
        clientHeight,
      } = viewport;
      const maxLeft = Math.max(0, scrollWidth - clientWidth);
      const left =
        getComputedStyle(viewport).direction === "rtl"
          ? maxLeft + scrollLeft
          : scrollLeft;
      const visible = clientWidth > 0 && clientHeight > 0;
      setOverflow({
        top: visible && scrollTop > 1,
        bottom: visible && scrollHeight - clientHeight - scrollTop > 1,
        left: visible && left > 1,
        right: visible && maxLeft - left > 1,
      });
      const bounds = props.fixed ? viewport.getBoundingClientRect() : undefined;
      const headerHeight =
        bounds && props.stickyHeader
          ? Math.min(
              clientHeight,
              Math.max(
                0,
                props.stickyHeader.getBoundingClientRect().bottom -
                  bounds.top -
                  viewport.clientTop,
              ),
            )
          : 0;
      setSize({ width: clientWidth, height: clientHeight - headerHeight });
      if (bounds) {
        const style = getComputedStyle(viewport);
        setPlacement({
          position: "fixed",
          left: `${bounds.left + viewport.clientLeft}px`,
          top: `${bounds.top + viewport.clientTop + headerHeight}px`,
          "z-index": style.zIndex,
          "border-radius": style.borderRadius,
          visibility: style.visibility as JSX.CSSProperties["visibility"],
        });
      }
    }

    /** Schedules one measurement for a burst of scroll or observer notifications. */
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);

    /**
     * Lists the elements whose size decides the content extent. Structure-only tracking looks
     * through `display: contents` wrappers, such as portal hosts, which have no box to resize.
     */
    function contentBoxes(parent: Element, boxes: Set<Element>) {
      for (const child of parent.children) {
        if (
          props.structureOnly &&
          getComputedStyle(child).display === "contents"
        ) {
          contentBoxes(child, boxes);
        } else {
          boxes.add(child);
        }
      }
      return boxes;
    }

    /** Tracks intrinsic content size without retaining children removed by reactive rendering. */
    function observeContent() {
      const children = contentBoxes(viewport, new Set());
      for (const child of observed) {
        if (!children.has(child)) {
          resize.unobserve(child);
          observed.delete(child);
        }
      }
      for (const child of children) {
        if (!observed.has(child)) {
          resize.observe(child);
          observed.add(child);
        }
      }
      schedule();
    }

    const mutation = new MutationObserver(observeContent);
    mutation.observe(
      viewport,
      props.structureOnly
        ? { childList: true, subtree: true }
        : {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          },
    );
    observeContent();
    viewport.addEventListener("scroll", schedule, { passive: true });
    viewport.addEventListener("load", schedule, true);
    if (props.fixed) {
      window.addEventListener("scroll", schedule, true);
      window.addEventListener("resize", schedule);
    }

    onCleanup(() => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      viewport.removeEventListener("scroll", schedule);
      viewport.removeEventListener("load", schedule, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    });
  });

  /**
   * Scrolls the viewport toward a clicked edge by roughly one visible page, less the space both
   * edges cover so content that was hidden under the far edge is not skipped. Animates unless
   * the app prefers reduced motion.
   */
  function scrollTowards(edge: (typeof edges)[number]) {
    const viewport = props.viewport;
    const horizontal = edge === "left" || edge === "right";
    const client = horizontal ? viewport.clientWidth : viewport.clientHeight;
    const bounds = edgeElements[edge]?.getBoundingClientRect();
    const cover = (horizontal ? bounds?.width : bounds?.height) ?? 0;
    const sign = edge === "left" || edge === "top" ? -1 : 1;
    const distance = sign * Math.max(client - 2 * cover, client / 2);
    viewport.scrollBy({
      left: horizontal ? distance : 0,
      top: horizontal ? 0 : distance,
      behavior:
        viewport.ownerDocument.documentElement.dataset.reducedMotion === "true"
          ? "auto"
          : "smooth",
    });
  }

  /**
   * Forwards wheel and trackpad scrolling over an edge to the viewport, which would otherwise
   * not scroll because visible edges capture the pointer above it. When the viewport cannot
   * move any further, the event is left alone so it chains to enclosing scroll containers.
   * Shift+wheel scrolls horizontally, matching native behaviour in browsers that report it as
   * vertical delta.
   */
  function forwardWheel(event: WheelEvent) {
    const viewport = props.viewport;
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientHeight
          : 1;
    const sideways = event.shiftKey && event.deltaX === 0;
    const { scrollLeft, scrollTop } = viewport;
    viewport.scrollBy({
      left: (sideways ? event.deltaY : event.deltaX) * scale,
      top: (sideways ? 0 : event.deltaY) * scale,
      behavior: "instant",
    });
    if (
      viewport.scrollLeft !== scrollLeft ||
      viewport.scrollTop !== scrollTop
    ) {
      event.preventDefault();
    }
  }

  return (
    <div
      class={`nf-scroll-indicators ${props.class ?? ""}`}
      aria-hidden="true"
      style={{
        ...placement(),
        width: `${size().width}px`,
        height: `${size().height}px`,
      }}
    >
      <For each={edges}>
        {(edge) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: A pointer shortcut only; keyboard users scroll the focusable viewport or its children directly.
          <span
            ref={(element) => {
              edgeElements[edge] = element;
            }}
            class="nf-scroll-edge"
            data-edge={edge}
            data-visible={overflow()[edge]}
            onMouseDown={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              // Portaled overlays sit outside their widget, so window-level outside-click
              // handlers (e.g. Preline's select) would otherwise close the menu being scrolled.
              event.stopPropagation();
              scrollTowards(edge);
            }}
            onWheel={forwardWheel}
          >
            <CaretRightIcon weight="bold" />
          </span>
        )}
      </For>
    </div>
  );
}

/** Keeps native scrolling while marking only edges that have content beyond the viewport. */
export function ScrollArea(props: ScrollAreaProps) {
  let viewport!: HTMLDivElement;
  return (
    <div class={`nf-scroll-area ${props.class ?? ""}`} style={props.style}>
      <div
        class={`nf-scroll-viewport ${props.viewportClass ?? ""}`}
        {...props.viewportProps}
        ref={(element) => {
          viewport = element;
          const ref = props.viewportProps?.ref;
          if (typeof ref === "function") ref(element);
        }}
      >
        {props.children}
      </div>
      <ScrollIndicators viewport={viewport} />
    </div>
  );
}
