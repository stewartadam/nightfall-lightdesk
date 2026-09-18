// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, type JSX, onCleanup, onMount } from "solid-js";

const SPLITTER_OPTIONS = JSON.stringify({ isSplittersAddedManually: true });

interface VerticalLayoutSplitterProps {
  top: JSX.Element;
  bottom: JSX.Element;
  topSize?: number;
  topMinSize?: number;
  class?: string;
  topClass?: string;
  bottomClass?: string;
  separatorLabel?: string;
}

interface LayoutSplitterInstance {
  destroy: () => void;
  on: (
    event: "drag",
    callback: (payload: LayoutSplitterDragPayload) => void,
  ) => void;
  setSplitterItemSize: (element: HTMLElement, size: number) => void;
}

interface LayoutSplitterDragPayload {
  previousFlexSize: number;
}

/** Renders two vertically resizable regions backed by Preline's layout splitter. */
export default function VerticalLayoutSplitter(
  props: VerticalLayoutSplitterProps,
) {
  let rootRef: HTMLDivElement | undefined;
  let topRef: HTMLDivElement | undefined;
  let bottomRef: HTMLDivElement | undefined;
  let layoutSplitter: LayoutSplitterInstance | undefined;
  let disposed = false;
  const topSize = props.topSize ?? 30;
  const bottomSize = 100 - topSize;
  const topOptions = JSON.stringify({ dynamicSize: topSize });
  const bottomOptions = JSON.stringify({ dynamicSize: bottomSize });
  const [currentTopSize, setCurrentTopSize] = createSignal(topSize);

  /** Initializes only this dynamically mounted splitter and retains it for cleanup. */
  const initializeLayoutSplitter = async (): Promise<void> => {
    const { HSLayoutSplitter } = await import("preline");
    if (disposed || !rootRef || !document.contains(rootRef)) return;
    layoutSplitter = new HSLayoutSplitter(rootRef);
    layoutSplitter.on("drag", ({ previousFlexSize }) =>
      setCurrentTopSize(Number(previousFlexSize.toFixed(1))),
    );
  };

  onMount(() => void initializeLayoutSplitter());
  onCleanup(() => {
    disposed = true;
    layoutSplitter?.destroy();
    layoutSplitter = undefined;
  });

  /** Resizes both panes in five-percent increments from the focused separator. */
  const resizeWithKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!layoutSplitter || !topRef || !bottomRef) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextTopSize = Math.min(
      100,
      Math.max(0, currentTopSize() + direction * 5),
    );
    layoutSplitter.setSplitterItemSize(topRef, nextTopSize);
    layoutSplitter.setSplitterItemSize(bottomRef, 100 - nextTopSize);
    setCurrentTopSize(nextTopSize);
  };

  return (
    <div
      ref={rootRef}
      class={`min-h-0 min-w-0 ${props.class ?? ""}`.trim()}
      data-hs-layout-splitter={SPLITTER_OPTIONS}
      data-component="VerticalLayoutSplitter"
    >
      <div
        class="flex size-full min-h-0 min-w-0 flex-col"
        data-hs-layout-splitter-vertical-group
      >
        <div
          ref={topRef}
          class={`min-h-0 min-w-0 overflow-hidden ${props.topClass ?? ""}`.trim()}
          data-hs-layout-splitter-item={topOptions}
          data-slot="top"
          style={{
            flex: `${topSize} 1 0px`,
            "min-height":
              props.topMinSize === undefined
                ? undefined
                : `${props.topMinSize}px`,
          }}
        >
          {props.top}
        </div>
        <div
          class="hs-layout-splitter-control group relative flex h-2 shrink-0 cursor-row-resize touch-none items-center border-y border-neutral-700 bg-neutral-900 transition-colors hover:bg-blue-500/30"
          data-layout-splitter-handle
          role="separator"
          aria-label={props.separatorLabel ?? "Resize sections"}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={currentTopSize()}
          tabIndex={0}
          onKeyDown={resizeWithKeyboard}
        >
          <div class="mx-auto h-px w-14 rounded bg-neutral-500 group-hover:bg-blue-200" />
        </div>
        <div
          ref={bottomRef}
          class={`min-h-0 min-w-0 overflow-hidden ${props.bottomClass ?? ""}`.trim()}
          data-hs-layout-splitter-item={bottomOptions}
          data-slot="bottom"
          style={{ flex: `${bottomSize} 1 0px` }}
        >
          {props.bottom}
        </div>
      </div>
    </div>
  );
}
