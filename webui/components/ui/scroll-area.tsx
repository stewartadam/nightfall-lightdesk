// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { createSignal, For, type JSX, onCleanup, onMount } from "solid-js";
import "./scroll-area.css";

interface ScrollAreaProps {
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
}

/** Observes an existing viewport and decorates only edges with content beyond it. */
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

    /** Tracks intrinsic content size without retaining children removed by reactive rendering. */
    function observeContent() {
      const children = new Set(viewport.children);
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
    mutation.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    observeContent();
    viewport.addEventListener("scroll", schedule, { passive: true });
    viewport.addEventListener("load", schedule, true);
    if (props.fixed) {
      window.addEventListener("scroll", schedule, true);
      window.addEventListener("resize", schedule);
    }

    /** Rejects pointer activation beneath visible blur without intercepting native wheel or touch panning. */
    function blockCoveredPointer(event: MouseEvent) {
      if (event.type === "click" && event.detail === 0) return;
      const covered = edges.some((edge) => {
        if (!overflow()[edge]) return false;
        const bounds = edgeElements[edge]?.getBoundingClientRect();
        return (
          bounds &&
          event.clientX >= bounds.left &&
          event.clientX < bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY < bounds.bottom
        );
      });
      if (!covered) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    const blockedEvents = [
      "pointerdown",
      "click",
      "dblclick",
      "auxclick",
      "contextmenu",
      "dragstart",
    ] as const;
    for (const type of blockedEvents) {
      viewport.addEventListener(type, blockCoveredPointer, true);
    }
    onCleanup(() => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      viewport.removeEventListener("scroll", schedule);
      viewport.removeEventListener("load", schedule, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      for (const type of blockedEvents) {
        viewport.removeEventListener(type, blockCoveredPointer, true);
      }
    });
  });

  return (
    <div
      class="nf-scroll-indicators"
      aria-hidden="true"
      style={{
        ...placement(),
        width: `${size().width}px`,
        height: `${size().height}px`,
      }}
    >
      <For each={edges}>
        {(edge) => (
          <span
            ref={(element) => {
              edgeElements[edge] = element;
            }}
            class="nf-scroll-edge"
            data-edge={edge}
            data-visible={overflow()[edge]}
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
