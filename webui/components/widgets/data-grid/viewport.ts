// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo } from "solid-js";
import type { Item } from "../../../lib/data-grid-types";
import { clampIndex } from "./event-adapter";
import type {
  DataGridTableColumn,
  DataGridTableRow,
} from "./model/column-model";

interface DataGridViewportControllerOptions {
  rows: () => readonly DataGridTableRow[];
  rowHeight: () => number;
  headerRowCount: () => number;
  headerRowHeight: number;
  markerWidth: () => number;
  columns: () => readonly DataGridTableColumn[];
  centerColumns: () => readonly DataGridTableColumn[];
  startWidth: () => number;
  centerWidth: () => number;
  scrollElement: () => HTMLDivElement | undefined;
}

/** Owns DataGrid row/column virtualization and viewport navigation geometry. */
export function createDataGridViewportController(
  options: DataGridViewportControllerOptions,
) {
  const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return options.rows().length;
    },
    getItemKey: (index) => options.rows()[index]?.id ?? index,
    getScrollElement: () => options.scrollElement() ?? null,
    estimateSize: options.rowHeight,
    overscan: 10,
  });
  const columnVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    horizontal: true,
    get count() {
      return options.centerColumns().length;
    },
    getItemKey: (index) => options.centerColumns()[index]?.id ?? index,
    getScrollElement: () => options.scrollElement() ?? null,
    estimateSize: (index) => options.centerColumns()[index]?.getSize() ?? 120,
    get scrollMargin() {
      return options.markerWidth() + options.startWidth();
    },
    overscan: 4,
  });

  /** Returns the current virtual row metadata from TanStack's virtualizer. */
  const virtualRows = createMemo(() => rowVirtualizer.getVirtualItems());

  /** Returns primitive row indexes so Solid preserves DOM across metadata refreshes. */
  const virtualRowIndexes = createMemo(() =>
    virtualRows().map((row) => row.index),
  );

  /** Looks up fresh virtual row metadata for a stably keyed rendered row. */
  const virtualRowByIndex = createMemo(
    () => new Map(virtualRows().map((row) => [row.index, row])),
  );

  /** Returns horizontally virtualized center columns that still exist in the latest set. */
  const scrollableVirtualColumns = createMemo(() => {
    const columnCount = options.centerColumns().length;
    return columnVirtualizer
      .getVirtualItems()
      .filter((column) => column.index < columnCount);
  });

  /** Returns primitive column indexes so Solid preserves DOM across metadata refreshes. */
  const scrollableVirtualColumnIndexes = createMemo(() =>
    scrollableVirtualColumns().map((column) => column.index),
  );

  /** Computes the spacer before the first rendered virtual column. */
  const leadingVirtualColumnSpacerWidth = () => {
    const first = scrollableVirtualColumns()[0];
    const scrollMargin = options.markerWidth() + options.startWidth();
    return first ? Math.max(0, first.start - scrollMargin) : 0;
  };

  /** Computes the spacer after the final rendered virtual column. */
  const trailingVirtualColumnSpacerWidth = () => {
    const columns = scrollableVirtualColumns();
    const last = columns[columns.length - 1];
    const scrollMargin = options.markerWidth() + options.startWidth();
    return last
      ? Math.max(0, options.centerWidth() - (last.end - scrollMargin))
      : options.centerWidth();
  };

  /** Returns the body row currently closest to the top of the scroll viewport. */
  const topVisibleBodyRow = (): number => {
    const rowCount = options.rows().length;
    if (rowCount <= 0) return 0;
    return clampIndex(
      Math.floor(
        (options.scrollElement()?.scrollTop ?? 0) / options.rowHeight(),
      ),
      rowCount,
    );
  };

  /** Returns the number of body rows covered by one page navigation step. */
  const pageNavigationRowDelta = (): number => {
    const scrollElement = options.scrollElement();
    if (!scrollElement) return 1;
    const headerHeight = options.headerRowCount() * options.headerRowHeight;
    const bodyHeight = Math.max(
      options.rowHeight(),
      scrollElement.clientHeight - headerHeight,
    );
    return Math.max(1, Math.floor(bodyHeight / options.rowHeight()) - 1);
  };

  /** Returns an overlay's left position in scrolled content coordinates. */
  const scrolledColumnLeft = (columnIndex: number): number => {
    const column = options.columns()[columnIndex];
    if (!column) return options.markerWidth();
    const start =
      column.getIsPinned() === "start"
        ? column.getStart("start")
        : options.startWidth() + column.getStart("center");
    return (
      options.markerWidth() + start + (options.scrollElement()?.scrollLeft ?? 0)
    );
  };

  /** Scrolls the grid viewport until the target cell is visible in both axes. */
  const scrollCellIntoView = (target: Item): void => {
    const scrollElement = options.scrollElement();
    if (!scrollElement) return;

    const [col, row] = target;
    const headerHeight = options.headerRowCount() * options.headerRowHeight;
    const cellTop = headerHeight + row * options.rowHeight();
    const cellBottom = cellTop + options.rowHeight();
    const visibleTop = scrollElement.scrollTop + headerHeight;
    const visibleBottom = scrollElement.scrollTop + scrollElement.clientHeight;

    if (cellTop < visibleTop) {
      scrollElement.scrollTop = Math.max(0, cellTop - headerHeight);
    } else if (cellBottom > visibleBottom) {
      scrollElement.scrollTop = cellBottom - scrollElement.clientHeight;
    }

    const column = options.columns()[col];
    if (!column) return;
    if (column.getIsPinned() === "start") {
      scrollElement.scrollLeft = 0;
      return;
    }

    const markerWidth = options.markerWidth();
    const frozenWidth = options.startWidth();
    const visibleLeft = scrollElement.scrollLeft + markerWidth + frozenWidth;
    const visibleRight = scrollElement.scrollLeft + scrollElement.clientWidth;
    const cellLeft = markerWidth + frozenWidth + column.getStart("center");
    const cellRight = cellLeft + column.getSize();

    if (cellLeft < visibleLeft) {
      scrollElement.scrollLeft = Math.max(
        0,
        cellLeft - markerWidth - frozenWidth,
      );
      return;
    }

    if (cellRight > visibleRight) {
      scrollElement.scrollLeft = cellRight - scrollElement.clientWidth;
    }
  };

  /** Re-measures virtual columns whenever resolved widths change. */
  createEffect(() => {
    const widths = options
      .centerColumns()
      .map((column) => column.getSize())
      .join(",");
    void widths;
    columnVirtualizer.measure();
  });

  /** Re-measures virtual rows whenever the row count changes. */
  createEffect(() => {
    const rowCount = options.rows().length;
    void rowCount;
    rowVirtualizer.measure();
  });

  return {
    columnVirtualizer,
    leadingVirtualColumnSpacerWidth,
    pageNavigationRowDelta,
    rowVirtualizer,
    scrollableVirtualColumnIndexes,
    scrolledColumnLeft,
    scrollCellIntoView,
    topVisibleBodyRow,
    trailingVirtualColumnSpacerWidth,
    virtualRowByIndex,
    virtualRowIndexes,
    virtualRows,
  };
}

/** Returns whether computed CSS currently allows an element to paint. */
function readComputedStyleVisible(element: HTMLElement): boolean {
  const computedStyle = window.getComputedStyle(element);
  return (
    computedStyle.display !== "none" &&
    computedStyle.visibility !== "hidden" &&
    computedStyle.opacity !== "0"
  );
}

/** Observes browser-native causes of computed visibility changes. */
export function observeComputedStyleVisibility(
  element: HTMLElement,
  onChange: (visible: boolean) => void,
): () => void {
  let disposed = false;
  let frame: number | undefined;
  let previousVisible = readComputedStyleVisible(element);
  const mutationObserver = new MutationObserver(() => checkVisibility());
  const resizeObserver = new ResizeObserver(() => scheduleCheck());

  /** Publishes a visibility sample when it differs from the previous one. */
  const checkVisibility = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    if (disposed) return;

    const nextVisible = readComputedStyleVisible(element);
    if (nextVisible === previousVisible) return;
    previousVisible = nextVisible;
    onChange(nextVisible);
  };

  /** Coalesces DOM observer churn into the next animation frame. */
  function scheduleCheck(): void {
    if (frame !== undefined || disposed) return;
    frame = window.requestAnimationFrame(checkVisibility);
  }

  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    mutationObserver.observe(current, {
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      attributes: true,
    });
  }
  resizeObserver.observe(element);
  document.addEventListener("visibilitychange", scheduleCheck);
  window.addEventListener("resize", scheduleCheck);
  onChange(previousVisible);

  return () => {
    disposed = true;
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", scheduleCheck);
    window.removeEventListener("resize", scheduleCheck);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
}

/** Formats numeric style sizes as pixels while passing through CSS size strings. */
export function styleSize(
  value: number | string | undefined,
  fallback: string,
): string {
  if (typeof value === "number") return `${value}px`;
  return value ?? fallback;
}
