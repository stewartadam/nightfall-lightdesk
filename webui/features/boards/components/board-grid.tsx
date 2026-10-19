// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { DropdownMenu } from "../../../components/ui/dropdown-menu";
import { dragCarriesObject } from "../../../lib/object-drag";
import type * as types from "../../../types";
import { TempoPad } from "../../tempo";
import { openAddMenu, openElementMenu } from "../controllers/board-menus";
import type { BoardPanelController } from "../controllers/board-panel-controller";
import {
  BOARD_CELL_PX,
  BUTTON_SPAN,
  boardExtent,
  boardTargetFromDrag,
  cellBetween,
  collectionColumns,
  describeQuery,
} from "../model/board-model";
import {
  boardMaxDimension,
  canPlaceElement,
  cellAtPoint,
  firstFittingCell,
} from "../model/board-placement";
import { ElementSettings } from "./board-properties";
import "./board.css";

/** Margin around the grid inside its scrolling area in CSS pixels; matches board.css. */
const GRID_MARGIN = 8;
/** Gap between buttons inside a collection in CSS pixels; matches board.css. */
const COLLECTION_GAP = 4;
/** Longest a dropped element waits for the engine before falling back to its stored cell. */
const SETTLE_TIMEOUT_MS = 2000;
/** Pointer travel in CSS pixels before a press on empty cells becomes a dragged-out area. */
const AREA_DRAG_THRESHOLD = 4;

interface BoardGridProps {
  controller: BoardPanelController;
  board: types.Board;
}

/** An in-progress move or resize of one element while editing. */
interface PlacementDrag {
  element: types.BoardElement;
  mode: "move" | "resize";
  /** Cell offset of the pointer from the element's top-left corner when a move started. */
  grabX: number;
  grabY: number;
  /** Cell the element would take if the pointer were released now. */
  cell: types.BoardCell;
}

/** An in-progress rectangle dragged out over empty cells to add an element there. */
interface AreaDrag {
  pointerId: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  startClientX: number;
  startClientY: number;
  /** Whether the pointer has travelled far enough to count as a drag rather than a click. */
  moved: boolean;
}

/** Cell offsets for each arrow key used to move or resize the focused element. */
const ARROW_STEPS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Returns the name screen readers announce for an element while editing. */
function elementAccessibleName(element: types.BoardElement): string {
  switch (element.kind.type) {
    case "Target":
      return `Button ${element.label ?? ""}`.trim();
    case "Collection":
      return `Collection ${element.label ?? describeQuery(element.kind.data.query)}`;
    case "Frame":
      return `Frame ${element.label ?? ""}`.trim();
    case "Label":
      return `Label ${element.label ?? ""}`.trim();
    case "Tempo":
      return "Tempo";
  }
}

/** Returns whether two cell rectangles have the same position and size. */
function sameCell(left: types.BoardCell, right: types.BoardCell): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Returns the CSS grid placement for a cell rectangle. */
function cellStyle(cell: types.BoardCell): JSX.CSSProperties {
  return {
    "grid-column": `${cell.x + 1} / span ${cell.width}`,
    "grid-row": `${cell.y + 1} / span ${cell.height}`,
  };
}

/** Renders one button with its live state, tinted by the element's color. */
function BoardButton(props: {
  element: types.BoardElement;
  item: types.BoardItem;
  caption?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      class="nf-board-button"
      data-state={props.item.state}
      data-board-button={props.item.label}
      aria-pressed={props.item.state === "On"}
      onClick={() => props.onPress()}
    >
      <span class="nf-board-button-label">
        {props.item.state === "Missing"
          ? "Deleted"
          : props.caption || props.item.label || `${props.item.id}`}
      </span>
      <Show when={props.item.state !== "Missing"}>
        <span class="nf-board-button-id">{props.item.id}</span>
      </Show>
    </button>
  );
}

/**
 * Renders the content of one element: a button, a filled collection, a frame, a label or a
 * tempo pad.
 */
function ElementContent(props: {
  controller: BoardPanelController;
  element: types.BoardElement;
}) {
  const items = () => props.controller.itemsFor(props.element.uid);
  const kind = () => props.element.kind;

  return (
    <>
      <Show when={kind().type === "Target"}>
        <Show
          when={items()[0]}
          fallback={<div class="nf-board-empty-region">Loading</div>}
        >
          {(item) => (
            <BoardButton
              element={props.element}
              item={item()}
              caption={props.element.label}
              onPress={() => props.controller.press(props.element, item())}
            />
          )}
        </Show>
      </Show>
      <Show
        when={(() => {
          const current = kind();
          return current.type === "Collection" ? current.data : undefined;
        })()}
      >
        {(data) => (
          <div class="nf-board-collection">
            <Show when={props.element.show_title}>
              <div class="nf-board-caption">
                {props.element.label || describeQuery(data().query)}
              </div>
            </Show>
            <Show
              when={items().length > 0}
              fallback={
                <div class="nf-board-empty-region">Nothing matches yet</div>
              }
            >
              <div
                class="nf-board-collection-items"
                style={{
                  "grid-template-columns": `repeat(${collectionColumns(props.element.cell.width)}, minmax(0, 1fr))`,
                  "grid-auto-rows": `${BUTTON_SPAN.height * BOARD_CELL_PX - COLLECTION_GAP}px`,
                }}
              >
                <Index each={items()}>
                  {(item) => (
                    <BoardButton
                      element={props.element}
                      item={item()}
                      onPress={() =>
                        props.controller.press(props.element, item())
                      }
                    />
                  )}
                </Index>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={kind().type === "Frame"}>
        <Show when={props.element.show_title || props.controller.editing()}>
          <div
            class="nf-board-caption nf-board-frame-handle"
            data-hidden-title={!props.element.show_title}
          >
            {props.element.label || "Frame"}
          </div>
        </Show>
      </Show>
      <Show when={kind().type === "Label"}>
        <div class="nf-board-label">{props.element.label}</div>
      </Show>
      <Show when={kind().type === "Tempo"}>
        <TempoPad class="nf-board-tempo" />
      </Show>
    </>
  );
}

/** Gear button on an element that pops out its settings while editing. */
function ElementSettingsButton(props: {
  controller: BoardPanelController;
  element: types.BoardElement;
}) {
  const controller = props.controller;
  return (
    // Keeps presses on the gear from starting a move of the element under it.
    <div
      class="nf-board-element-gear"
      role="presentation"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu
        align="end"
        placement="below"
        triggerLabel="Element settings"
        contentLabel="Element settings"
        triggerClass="nf-board-gear-trigger"
        open={controller.settingsElementUid() === props.element.uid}
        onOpenChange={(open) => {
          if (open) controller.openElementSettings(props.element.uid);
          else if (controller.settingsElementUid() === props.element.uid) {
            controller.setSettingsElementUid(null);
          }
        }}
        trigger={<GearSixIcon class="size-3.5" aria-hidden />}
      >
        <div class="max-h-[70vh] w-72 overflow-y-auto">
          <ElementSettings controller={controller} element={props.element} />
        </div>
      </DropdownMenu>
    </div>
  );
}

/**
 * Draws a board's grid and elements. In operate mode buttons run their default action. In
 * edit mode elements can be selected, dragged to move, resized from their corner handle,
 * configured from their gear or right-click menu, and new elements are added by dragging out
 * an area of empty cells. Objects dragged in from their panels are pinned where they drop.
 */
export function BoardGrid(props: BoardGridProps) {
  const controller = props.controller;
  let gridRef: HTMLDivElement | undefined;
  const [drag, setDrag] = createSignal<PlacementDrag | null>(null);
  const [areaDrag, setAreaDrag] = createSignal<AreaDrag | null>(null);
  /**
   * Placement of an element just dropped, shown until the engine stores it so the element does
   * not snap back to its old cell for a frame before jumping to the new one.
   */
  const [settling, setSettling] = createSignal<{
    uid: string;
    cell: types.BoardCell;
  } | null>(null);

  /**
   * Stops showing a dropped placement once the engine's copy of the element reaches it, or
   * after a timeout when the engine refuses the move or never answers.
   */
  createEffect(() => {
    const pending = settling();
    if (!pending) return;
    const stored = controller.elementByUid(pending.uid)?.cell;
    if (!stored || sameCell(stored, pending.cell)) {
      setSettling(null);
      return;
    }
    const timeout = window.setTimeout(
      () => setSettling(null),
      SETTLE_TIMEOUT_MS,
    );
    onCleanup(() => window.clearTimeout(timeout));
  });
  const [dropCell, setDropCell] = createSignal<{ x: number; y: number } | null>(
    null,
  );

  const [viewport, setViewport] = createSignal({ columns: 0, rows: 0 });

  /**
   * Tracks how many whole cells fit in the visible part of the panel, so the grid always fills
   * it and new elements look for room within the visible width.
   */
  onMount(() => {
    const scroller = gridRef?.parentElement;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      const columns = Math.floor(
        (scroller.clientWidth - GRID_MARGIN * 2) / BOARD_CELL_PX,
      );
      const rows = Math.floor(
        (scroller.clientHeight - GRID_MARGIN * 2) / BOARD_CELL_PX,
      );
      setViewport({ columns: Math.max(columns, 1), rows: Math.max(rows, 1) });
      controller.setVisibleColumns(Math.max(columns, 1));
    });
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  /** Returns the grid cell under a pointer position. */
  const pointerCell = (clientX: number, clientY: number) => {
    const rect = gridRef?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return cellAtPoint(rect, clientX, clientY);
  };

  /**
   * Area an object dragged in from another panel would take at the hovered cell, and whether
   * it fits there without covering another element.
   */
  const dropArea = createMemo(() => {
    const at = dropCell();
    if (!at) return null;
    const cell = { ...at, ...BUTTON_SPAN };
    return { cell, fits: canPlaceElement(props.board, cell, "Target") };
  });

  /**
   * Closes the board and element settings pop-outs. Grid presses cancel their pointerdown, so
   * the browser skips the mousedown the pop-outs listen for to close on outside presses.
   */
  const closePopOuts = () => {
    controller.setBoardSettingsOpen(false);
    controller.setSettingsElementUid(null);
  };

  /** Clears the drop highlight when a drag ends anywhere, including a cancelled drag. */
  const clearDropCell = () => setDropCell(null);
  onMount(() => {
    window.addEventListener("dragend", clearDropCell);
    window.addEventListener("drop", clearDropCell);
  });
  onCleanup(() => {
    window.removeEventListener("dragend", clearDropCell);
    window.removeEventListener("drop", clearDropCell);
  });

  /** Starts moving or resizing an element under the pointer while editing. */
  const beginDrag = (
    event: PointerEvent,
    element: types.BoardElement,
    mode: PlacementDrag["mode"],
  ) => {
    if (!controller.editing() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    closePopOuts();
    controller.selectElement(element.uid);
    const target = event.currentTarget as HTMLElement;
    // preventDefault above also stops the browser focusing the element, which arrow keys need.
    target
      .closest<HTMLElement>("[data-board-element]")
      ?.focus({ preventScroll: true });
    const at = pointerCell(event.clientX, event.clientY);
    target.setPointerCapture(event.pointerId);
    setDrag({
      element,
      mode,
      grabX: at.x - element.cell.x,
      grabY: at.y - element.cell.y,
      cell: element.cell,
    });
  };

  /**
   * Updates the previewed cell as the pointer moves. A move or resize that would cover another
   * element (frames aside) or leave the board is refused: a move slides along whichever axis
   * is still free, otherwise the preview stays at the last spot that fit.
   */
  const updateDrag = (event: PointerEvent) => {
    const current = drag();
    if (!current) return;
    const at = pointerCell(event.clientX, event.clientY);
    const { element } = current;
    let candidates: types.BoardCell[];
    if (current.mode === "move") {
      const maxDimension = boardMaxDimension();
      const x = Math.min(
        Math.max(at.x - current.grabX, 0),
        maxDimension - element.cell.width,
      );
      const y = Math.min(
        Math.max(at.y - current.grabY, 0),
        maxDimension - element.cell.height,
      );
      candidates = [
        { ...current.cell, x, y },
        { ...current.cell, x },
        { ...current.cell, y },
      ];
    } else {
      const width = Math.max(at.x - element.cell.x + 1, 1);
      const height = Math.max(at.y - element.cell.y + 1, 1);
      candidates = [
        { ...current.cell, width, height },
        { ...current.cell, width },
        { ...current.cell, height },
      ];
    }
    const cell = firstFittingCell(
      props.board,
      candidates,
      element.kind.type,
      element.uid,
    );
    if (cell) setDrag({ ...current, cell });
  };

  /** Commits the previewed placement when the pointer is released. */
  const endDrag = () => {
    const current = drag();
    setDrag(null);
    if (current && controller.placeElement(current.element, current.cell)) {
      setSettling({ uid: current.element.uid, cell: current.cell });
    }
  };

  /**
   * Starts dragging out an area when a press lands on empty cells while editing. Presses on
   * elements are handled by the element itself.
   */
  const beginAreaDrag = (event: PointerEvent) => {
    const target = event.target as Element;
    if (!gridRef?.contains(target) || target.closest("[data-board-element]")) {
      return;
    }
    if (!controller.editing() || event.button !== 0) return;
    event.preventDefault();
    closePopOuts();
    gridRef?.focus({ preventScroll: true });
    gridRef?.setPointerCapture(event.pointerId);
    const at = pointerCell(event.clientX, event.clientY);
    setAreaDrag({
      pointerId: event.pointerId,
      start: at,
      end: at,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    });
  };

  /** Grows the dragged-out area as the pointer moves. */
  const updateAreaDrag = (event: PointerEvent) => {
    const current = areaDrag();
    if (!current || current.pointerId !== event.pointerId) return;
    const moved =
      current.moved ||
      Math.hypot(
        event.clientX - current.startClientX,
        event.clientY - current.startClientY,
      ) > AREA_DRAG_THRESHOLD;
    setAreaDrag({
      ...current,
      end: pointerCell(event.clientX, event.clientY),
      moved,
    });
  };

  /**
   * Finishes an area drag: a drag opens the add menu for the area, while a plain click clears
   * the selection and marks the cell as the paste spot.
   */
  const endAreaDrag = (event: PointerEvent) => {
    const current = areaDrag();
    if (!current || current.pointerId !== event.pointerId) return;
    setAreaDrag(null);
    const area = cellBetween(current.start, current.end);
    if (current.moved) {
      // An area within one cell carries no size, so each kind gets its default one.
      const sized = area.width > 1 || area.height > 1;
      openAddMenu(
        controller,
        sized ? area : current.start,
        event.clientX,
        event.clientY,
      );
      return;
    }
    controller.selectElement(null);
    controller.setPasteAnchor(current.start);
  };

  /**
   * Edits the focused element from the keyboard while editing: arrow keys move it one cell,
   * Shift+arrow keys resize it, and Enter or Space selects it. Delete and the clipboard keys
   * are panel shortcuts acting on the selected element.
   */
  const handleElementKey = (
    event: KeyboardEvent,
    element: types.BoardElement,
  ) => {
    // Keys typed in the element's settings pop-out bubble here through its portal.
    if (!controller.editing() || event.target !== event.currentTarget) return;
    const step = ARROW_STEPS[event.key];
    if (step) {
      event.preventDefault();
      controller.selectElement(element.uid);
      const { cell } = element;
      controller.placeElement(
        element,
        event.shiftKey
          ? {
              ...cell,
              width: Math.max(cell.width + step.x, 1),
              height: Math.max(cell.height + step.y, 1),
            }
          : { ...cell, x: cell.x + step.x, y: cell.y + step.y },
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      controller.selectElement(element.uid);
    }
  };

  /** Returns where an element is drawn, following an in-progress drag of it. */
  const placementOf = (element: types.BoardElement) => {
    const current = drag();
    if (current?.element.uid === element.uid) return current.cell;
    const pending = settling();
    return pending?.uid === element.uid ? pending.cell : element.cell;
  };

  /** Area currently being dragged out, once the pointer has moved far enough to show it. */
  const draggedArea = () => {
    const current = areaDrag();
    return current?.moved ? cellBetween(current.start, current.end) : null;
  };

  /**
   * Columns and rows the grid draws: the visible area, grown to reach every element and any
   * dragged element, dragged-out area or drop highlight so the board scrolls to show them.
   */
  const gridSize = createMemo(() => {
    const extent = boardExtent(props.board);
    const transient = [drag()?.cell, draggedArea(), dropArea()?.cell];
    let columns = Math.max(viewport().columns, extent.columns);
    let rows = Math.max(viewport().rows, extent.rows);
    for (const cell of transient) {
      if (!cell) continue;
      columns = Math.max(columns, cell.x + cell.width);
      rows = Math.max(rows, cell.y + cell.height);
    }
    return { columns, rows };
  });

  return (
    <div
      ref={gridRef}
      class="nf-board-grid"
      classList={{
        "nf-board-editing": controller.editing(),
        "nf-board-dropping": dropCell() !== null,
      }}
      data-board-grid={props.board.identifiers.uid}
      tabIndex={-1}
      style={{
        "grid-template-columns": `repeat(${gridSize().columns}, ${BOARD_CELL_PX}px)`,
        "grid-template-rows": `repeat(${gridSize().rows}, ${BOARD_CELL_PX}px)`,
      }}
      onPointerDown={beginAreaDrag}
      onPointerMove={(event) => {
        updateDrag(event);
        updateAreaDrag(event);
      }}
      onPointerUp={(event) => {
        endDrag();
        endAreaDrag(event);
      }}
      onPointerCancel={() => {
        setDrag(null);
        setAreaDrag(null);
      }}
      onContextMenu={(event) => {
        if (
          !controller.editing() ||
          !gridRef?.contains(event.target as Node) ||
          (event.target as Element).closest("[data-board-element]")
        ) {
          return;
        }
        event.preventDefault();
        openAddMenu(
          controller,
          pointerCell(event.clientX, event.clientY),
          event.clientX,
          event.clientY,
        );
      }}
      onDragOver={(event) => {
        if (!dragCarriesObject(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        setDropCell(pointerCell(event.clientX, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!gridRef?.contains(event.relatedTarget as Node | null)) {
          setDropCell(null);
        }
      }}
      onDrop={(event) => {
        setDropCell(null);
        if (!event.dataTransfer) return;
        const target = boardTargetFromDrag(event.dataTransfer);
        if (!target) return;
        event.preventDefault();
        controller.dropTarget(
          target,
          pointerCell(event.clientX, event.clientY),
        );
      }}
    >
      <For each={controller.elementUids()}>
        {(uid) => (
          <Show when={controller.elementByUid(uid)}>
            {(element) => (
              <div
                class="nf-board-element"
                data-kind={element().kind.type}
                data-board-element={uid}
                data-selected={
                  controller.editing() &&
                  controller.selectedElement()?.uid === uid
                }
                data-preview={drag()?.element.uid === uid}
                style={{
                  ...cellStyle(placementOf(element())),
                  ...(element().color
                    ? { "--nf-board-color": element().color }
                    : {}),
                }}
                role="group"
                tabIndex={controller.editing() ? 0 : undefined}
                aria-label={elementAccessibleName(element())}
                onPointerDown={(event) => beginDrag(event, element(), "move")}
                onKeyDown={(event) => handleElementKey(event, element())}
                onLostPointerCapture={() => endDrag()}
                onContextMenu={(event) => {
                  // Right-clicks in the settings pop-out bubble here through its portal.
                  if (!event.currentTarget.contains(event.target as Node)) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  openElementMenu(
                    controller,
                    element(),
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                <ElementContent controller={controller} element={element()} />
                <Show when={controller.editing()}>
                  <ElementSettingsButton
                    controller={controller}
                    element={element()}
                  />
                </Show>
                <Show
                  when={
                    controller.editing() &&
                    controller.selectedElement()?.uid === uid
                  }
                >
                  <div
                    class="nf-board-resize"
                    role="presentation"
                    onPointerDown={(event) =>
                      beginDrag(event, element(), "resize")
                    }
                    onLostPointerCapture={() => endDrag()}
                  />
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
      <Show when={dropArea()}>
        {(area) => (
          <div
            class="nf-board-drop"
            data-board-drop=""
            data-fits={area().fits}
            style={cellStyle(area().cell)}
          />
        )}
      </Show>
      <Show when={draggedArea()}>
        {(area) => (
          <div
            class="nf-board-area"
            data-board-area=""
            style={cellStyle(area())}
          />
        )}
      </Show>
    </div>
  );
}
