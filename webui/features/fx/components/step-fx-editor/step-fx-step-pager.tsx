// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { ToolbarButton } from "../../../../components/ui/toolbar-button";

/** Pages step selectors only when their combined width exceeds the available bar. */
export function StepFxStepPager(props: {
  children: JSX.Element;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  let rootRef: HTMLDivElement | undefined;
  let viewportRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let refreshFrame: number | undefined;
  const [overflowed, setOverflowed] = createSignal(false);
  const [canPageBackward, setCanPageBackward] = createSignal(false);
  const [canPageForward, setCanPageForward] = createSignal(false);

  /** Synchronizes paging affordances with content width and scroll position. */
  const refreshPagerState = (): void => {
    if (!rootRef || !viewportRef || !contentRef) return;
    const nextOverflowed = contentRef.scrollWidth > rootRef.clientWidth + 1;
    if (!nextOverflowed && viewportRef.scrollLeft !== 0)
      viewportRef.scrollLeft = 0;
    setOverflowed(nextOverflowed);
    setCanPageBackward(nextOverflowed && viewportRef.scrollLeft > 1);
    setCanPageForward(
      nextOverflowed &&
        viewportRef.scrollLeft + viewportRef.clientWidth <
          contentRef.scrollWidth - 1,
    );
  };

  /** Coalesces resize notifications after the browser finishes the current layout. */
  const schedulePagerRefresh = (): void => {
    if (refreshFrame !== undefined) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = undefined;
      refreshPagerState();
    });
  };

  /** Moves by the largest whole selector group that fits in the viewport. */
  const pageSelectors = (direction: -1 | 1): void => {
    if (!viewportRef || !contentRef) return;
    const firstSelector = contentRef.firstElementChild;
    const selectorWidth =
      firstSelector instanceof HTMLElement
        ? firstSelector.getBoundingClientRect().width
        : 28;
    const gap = Number.parseFloat(getComputedStyle(contentRef).columnGap) || 4;
    const stride = selectorWidth + gap;
    const visibleCount = Math.max(
      1,
      Math.floor((viewportRef.clientWidth + gap) / stride),
    );
    viewportRef.scrollBy({
      left: direction * visibleCount * stride,
      behavior: "smooth",
    });
  };

  onMount(() => {
    if (!rootRef || !viewportRef || !contentRef) return;
    resizeObserver = new ResizeObserver(schedulePagerRefresh);
    resizeObserver.observe(rootRef);
    resizeObserver.observe(viewportRef);
    resizeObserver.observe(contentRef);
    schedulePagerRefresh();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame);
  });

  return (
    <div
      ref={rootRef}
      class="flex min-w-0 flex-1 items-center gap-1"
      data-step-fx-step-pager
    >
      <Show when={overflowed()}>
        <ToolbarButton
          label="Previous steps"
          class="shrink-0"
          disabled={!canPageBackward()}
          classList={{
            "cursor-not-allowed opacity-40": !canPageBackward(),
          }}
          onClick={() => pageSelectors(-1)}
        >
          <CaretLeftIcon class="size-4" weight="bold" aria-hidden />
        </ToolbarButton>
      </Show>
      <div
        ref={viewportRef}
        class="min-w-0 flex-1 overflow-hidden"
        data-step-fx-step-pager-viewport
        onScroll={refreshPagerState}
        onKeyDown={props.onKeyDown}
      >
        <div ref={contentRef} class="flex w-max items-center gap-1">
          {props.children}
        </div>
      </div>
      <Show when={overflowed()}>
        <ToolbarButton
          label="Next steps"
          class="shrink-0"
          disabled={!canPageForward()}
          classList={{
            "cursor-not-allowed opacity-40": !canPageForward(),
          }}
          onClick={() => pageSelectors(1)}
        >
          <CaretRightIcon class="size-4" weight="bold" aria-hidden />
        </ToolbarButton>
      </Show>
    </div>
  );
}
