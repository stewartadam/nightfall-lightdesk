// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show } from "solid-js";
import type { GroupHeaderClickedEventArgs } from "../../../lib/data-grid-types";
import type { DataGridTableHeader } from "./model/column-model";
import type { HeaderCellView } from "./model/types";

const HEADER_BACKGROUND = "var(--data-grid-header-bg, #212121)";
const SELECTED_HEADER_BACKGROUND =
  "var(--data-grid-selected-header-bg, rgba(23, 37, 84, 0.75))";

/** Layers a header color over the base header color for opaque sticky rendering. */
function opaqueStickyHeaderBackground(headerBackground: string): string {
  return `linear-gradient(${headerBackground}, ${headerBackground}), ${HEADER_BACKGROUND}`;
}

export interface HeaderCellProps {
  header: DataGridTableHeader;
  view: HeaderCellView;
  headerId: string;
  content: JSX.Element;
  widthVariable: string;
  sticky: boolean;
  left: number;
  obscuredWidth: number;
  selectedColumnSet: ReadonlySet<number>;
  isActivationKey: (event: KeyboardEvent) => boolean;
  onSelectColumns: (header: HeaderCellView) => void;
  onResizeColumn: (id: string, width: number) => void;
  onAutoSizeColumn: (header: HeaderCellView) => void;
  onGroupHeaderClicked?: (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
  ) => void;
  onColumnHeaderContextMenu?: (
    colIndex: number,
    event: GroupHeaderClickedEventArgs,
    header: HeaderCellView,
  ) => void;
}

/** Renders one TanStack header cell, including selection and resize affordances. */
export function HeaderCell(props: HeaderCellProps) {
  /** Enables sorting only for an explicitly sortable leaf header. */
  const canSort = () =>
    props.header.subHeaders.length === 0 && props.header.column.getCanSort();
  /** Sorts a leaf header or preserves the existing column-selection action. */
  const activateHeader = (event: MouseEvent | KeyboardEvent) => {
    if (canSort()) props.header.column.toggleSorting();
    else {
      props.onSelectColumns(props.view);
      dispatchGroupHeaderClicked(event);
    }
  };
  /** Returns whether all leaf columns under this header are selected. */
  const isHeaderSelected = () => {
    if (props.view.endLeafIndex <= props.view.firstLeafIndex) return false;
    for (
      let index = props.view.firstLeafIndex;
      index < props.view.endLeafIndex;
      index += 1
    ) {
      if (!props.selectedColumnSet.has(index)) return false;
    }
    return true;
  };

  /** Dispatches the grouped-header callback and reports prevention. */
  const dispatchGroupHeaderClicked = (event: MouseEvent | KeyboardEvent) => {
    if (props.header.subHeaders.length === 0) return false;

    let prevented = false;
    props.onGroupHeaderClicked?.(props.view.firstLeafIndex, {
      ...event,
      preventDefault: () => {
        prevented = true;
        event.preventDefault();
      },
    } as unknown as GroupHeaderClickedEventArgs);
    return prevented;
  };

  /** Dispatches the column-header context menu callback for this header. */
  const dispatchColumnHeaderContextMenu = (event: MouseEvent) => {
    let prevented = false;
    props.onColumnHeaderContextMenu?.(
      props.view.firstLeafIndex,
      {
        ...event,
        clientX: event.clientX,
        clientY: event.clientY,
        preventDefault: () => {
          prevented = true;
          event.preventDefault();
        },
      } as unknown as GroupHeaderClickedEventArgs,
      props.view,
    );
    if (prevented) event.stopPropagation();
  };

  /** Returns the visible header background for selected and default states. */
  const headerBackground = () =>
    isHeaderSelected() ? SELECTED_HEADER_BACKGROUND : HEADER_BACKGROUND;

  /** Starts TanStack's native mouse-driven resize lifecycle. */
  const handleResizeMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
    props.header.getResizeHandler()(event);
  };

  /** Starts TanStack's native touch-driven resize lifecycle. */
  const handleResizeTouchStart = (event: TouchEvent) => {
    event.stopPropagation();
    props.header.getResizeHandler()(event);
  };

  /** Fits the leaf column to its current content without selecting its header. */
  const handleResizeDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    props.onAutoSizeColumn(props.view);
  };

  /** Adjusts the TanStack-owned width without activating header sorting or selection. */
  const handleResizeKeyDown = (event: KeyboardEvent) => {
    if (props.isActivationKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") {
      props.header.column.resetSize();
      return;
    }
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const width =
      props.header.column.getSize() + direction * (event.shiftKey ? 1 : 10);
    props.onResizeColumn(
      props.header.column.id,
      Math.max(
        props.header.column.columnDef.minSize ?? 36,
        Math.min(props.header.column.columnDef.maxSize ?? Infinity, width),
      ),
    );
  };

  return (
    <div
      role="columnheader"
      aria-label={
        typeof props.view.label === "string" ? props.view.label : undefined
      }
      aria-sort={
        canSort()
          ? props.header.column.getIsSorted() === "asc"
            ? "ascending"
            : props.header.column.getIsSorted() === "desc"
              ? "descending"
              : "none"
          : undefined
      }
      tabIndex={0}
      data-selected={isHeaderSelected() ? "true" : "false"}
      class={`relative flex shrink-0 items-center overflow-hidden border-r border-white/20 bg-[#212121] px-2 font-semibold text-neutral-300 ${props.sticky ? "sticky z-40" : ""}`}
      data-grid-header-id={props.headerId}
      style={{
        width: `var(${props.widthVariable})`,
        left: props.sticky ? `${props.left}px` : undefined,
        background: props.sticky
          ? opaqueStickyHeaderBackground(headerBackground())
          : headerBackground(),
      }}
      onClick={activateHeader}
      onKeyDown={(event) => {
        if (!props.isActivationKey(event)) return;
        event.preventDefault();
        activateHeader(event);
      }}
      onContextMenu={dispatchColumnHeaderContextMenu}
    >
      <span
        class="truncate"
        style={{
          "margin-left": `${props.sticky ? 0 : props.obscuredWidth}px`,
        }}
      >
        {props.content}
      </span>
      <Show when={canSort()}>
        <span aria-hidden="true" class="ml-auto pl-2 text-xs">
          {props.header.column.getIsSorted() === "asc"
            ? "↑"
            : props.header.column.getIsSorted() === "desc"
              ? "↓"
              : "↕"}
        </span>
      </Show>
      <Show
        when={
          !props.header.isPlaceholder &&
          props.header.subHeaders.length === 0 &&
          props.header.column.getCanResize()
        }
      >
        <div
          data-grid-resize-handle="true"
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${String(props.header.column.columnDef.header ?? props.header.column.id)}`}
          aria-orientation="vertical"
          aria-valuenow={props.header.column.getSize()}
          aria-valuemin={props.header.column.columnDef.minSize ?? 36}
          class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-400"
          onMouseDown={handleResizeMouseDown}
          onTouchStart={handleResizeTouchStart}
          onDblClick={handleResizeDoubleClick}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleResizeKeyDown}
        />
      </Show>
    </div>
  );
}
