// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal } from "solid-js";

interface CrudGridDragSelectionOptions {
  enabled: Accessor<boolean>;
  orderedIds: Accessor<readonly string[]>;
  selectedIds: Accessor<readonly string[]>;
  onSelectionChange: (ids: string[]) => void;
}

interface DragState {
  pointerId: number;
  active: boolean;
  didDrag: boolean;
  pointerCaptured: boolean;
  container: HTMLElement;
  containerRect: DOMRect;
  baseSelection: Set<string>;
  additive: boolean;
  toggling: boolean;
  originX: number;
  originY: number;
}

interface DragBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CARD_ID_ATTR = "data-crud-select-id";

function getCardIdFromElement(element: Element | null): string | null {
  return element?.getAttribute(CARD_ID_ATTR) ?? null;
}

function getIdsIntersectingBox(
  container: HTMLElement,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Set<string> {
  const ids = new Set<string>();
  for (const card of container.querySelectorAll(`[${CARD_ID_ATTR}]`)) {
    const id = getCardIdFromElement(card);
    if (!id) continue;
    const rect = card.getBoundingClientRect();
    if (
      rect.right >= left &&
      rect.left <= right &&
      rect.bottom >= top &&
      rect.top <= bottom
    ) {
      ids.add(id);
    }
  }
  return ids;
}

export function createCrudGridDragSelection(
  options: CrudGridDragSelectionOptions,
) {
  let dragState: DragState | null = null;
  let suppressNextClick = false;
  const [dragBox, setDragBox] = createSignal<DragBox | null>(null);

  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  const orderSelection = (selected: Set<string>): string[] => {
    const orderedIds = options.orderedIds();
    return orderedIds.filter((id) => selected.has(id));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!options.enabled()) return;
    if (event.button !== 0) return;

    const container = event.currentTarget as HTMLElement | null;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const originX = clamp(
      event.clientX - containerRect.left,
      0,
      containerRect.width,
    );
    const originY = clamp(
      event.clientY - containerRect.top,
      0,
      containerRect.height,
    );
    dragState = {
      pointerId: event.pointerId,
      active: true,
      didDrag: false,
      pointerCaptured: false,
      container,
      containerRect,
      baseSelection: new Set(options.selectedIds()),
      additive: event.shiftKey,
      toggling: event.ctrlKey || event.metaKey,
      originX,
      originY,
    };
    setDragBox({
      left: originX,
      top: originY,
      width: 0,
      height: 0,
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!options.enabled()) return;
    if (!dragState?.active) return;
    if (event.pointerId !== dragState.pointerId) return;

    const currentX = clamp(
      event.clientX - dragState.containerRect.left,
      0,
      dragState.containerRect.width,
    );
    const currentY = clamp(
      event.clientY - dragState.containerRect.top,
      0,
      dragState.containerRect.height,
    );
    setDragBox({
      left: Math.min(dragState.originX, currentX),
      top: Math.min(dragState.originY, currentY),
      width: Math.abs(currentX - dragState.originX),
      height: Math.abs(currentY - dragState.originY),
    });

    const movedPastThreshold =
      Math.abs(currentX - dragState.originX) > 4 ||
      Math.abs(currentY - dragState.originY) > 4;

    if (movedPastThreshold) {
      dragState.didDrag = true;
      if (!dragState.pointerCaptured) {
        dragState.container.setPointerCapture?.(event.pointerId);
        dragState.pointerCaptured = true;
      }
    }

    if (!dragState.didDrag) return;

    const left =
      dragState.containerRect.left + Math.min(dragState.originX, currentX);
    const top =
      dragState.containerRect.top + Math.min(dragState.originY, currentY);
    const right =
      dragState.containerRect.left + Math.max(dragState.originX, currentX);
    const bottom =
      dragState.containerRect.top + Math.max(dragState.originY, currentY);
    const hitIds = getIdsIntersectingBox(
      dragState.container,
      left,
      top,
      right,
      bottom,
    );

    let nextIds: Set<string>;
    if (dragState.toggling) {
      nextIds = new Set(dragState.baseSelection);
      for (const id of hitIds) {
        if (nextIds.has(id)) {
          nextIds.delete(id);
        } else {
          nextIds.add(id);
        }
      }
    } else if (dragState.additive) {
      nextIds = new Set(dragState.baseSelection);
      for (const id of hitIds) {
        nextIds.add(id);
      }
    } else {
      nextIds = hitIds;
    }

    options.onSelectionChange(orderSelection(nextIds));
    event.preventDefault();
  };

  const finishDrag = (event: PointerEvent) => {
    if (!dragState?.active) return;
    if (event.pointerId !== dragState.pointerId) return;

    if (
      dragState.pointerCaptured &&
      dragState.container.hasPointerCapture?.(event.pointerId)
    ) {
      dragState.container.releasePointerCapture(event.pointerId);
    }

    if (dragState.didDrag) {
      suppressNextClick = true;
    }
    dragState = null;
    setDragBox(null);
  };

  const onPointerUp = (event: PointerEvent) => {
    finishDrag(event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    finishDrag(event);
  };

  const consumeSuppressedClick = (): boolean => {
    if (!suppressNextClick) return false;
    suppressNextClick = false;
    return true;
  };

  return {
    cardIdAttr: CARD_ID_ATTR,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick,
    dragBox,
  };
}
