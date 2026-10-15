// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { type Accessor, createSignal } from "solid-js";
import {
  canMovePanelTransferToDefaultEdgeGroup,
  type DefaultEdgeGroupPosition,
  getHiddenDefaultEdgeDropTargets,
  hideEmptyDefaultEdgeGroups,
  isDefaultEdgeGroupPosition,
  movePanelTransferToDefaultEdgeGroup,
} from "./default-edge-groups";
import {
  dockviewHostStyle,
  getEdgeDropPositionFromPoint,
  isEdgeDropModifierPressed,
} from "./edge-drop-geometry";

const EDGE_DROP_HOLD_DELAY_MS = 500;

type EdgeDropPointerEvent = DragEvent | MouseEvent | PointerEvent;

interface EdgeGroupDropControllerOptions {
  /** The workspace's published Dockview API, or null before publish and after unmount. */
  api: Accessor<DockviewApi | null>;
}

/**
 * Routes drags onto hidden, empty default edge groups. While a panel or group
 * drag is in flight it exposes app-owned drop bands along those edges; holding
 * over a band (or pressing Alt) arms it, and dropping on an armed band moves
 * the transfer into the edge group instead of Dockview's regular edge split.
 * It also keeps empty default edges hidden and reports which of them should
 * reserve resting padding in the workspace host.
 */
export function createEdgeGroupDropController(
  options: EdgeGroupDropControllerOptions,
) {
  const [hiddenEdgePositions, setHiddenEdgePositions] = createSignal<
    DefaultEdgeGroupPosition[]
  >([], {
    /** Avoids relayout when resizing leaves the same edges hidden. */
    equals: (previous, next) => previous.join() === next.join(),
  });
  const [targetsActive, setTargetsActive] = createSignal(false);
  const [previewPosition, setPreviewPosition] =
    createSignal<DefaultEdgeGroupPosition>();
  const [armedPosition, setArmedPosition] =
    createSignal<DefaultEdgeGroupPosition>();
  const [targetPositions, setTargetPositions] = createSignal<
    DefaultEdgeGroupPosition[]
  >([]);

  /** Positions the Dockview host so armed bands and hidden edges get their insets. */
  const hostStyle = () =>
    dockviewHostStyle(armedPosition(), hiddenEdgePositions());

  /** Accepts drags over an armed band when its transfer can move into that edge group. */
  const handleZoneDragOver = (
    event: DragEvent,
    position: DefaultEdgeGroupPosition,
  ) => {
    const dockApi = options.api();
    if (!dockApi || armedPosition() !== position) return;
    if (!canMovePanelTransferToDefaultEdgeGroup(dockApi, position)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  };

  /** Moves the transfer into an armed band's edge group and hides every band. */
  const handleZoneDrop = (event: Event, position: DefaultEdgeGroupPosition) => {
    const dockApi = options.api();
    if (!dockApi || armedPosition() !== position) return;
    if (movePanelTransferToDefaultEdgeGroup(dockApi, position)) {
      event.preventDefault();
      event.stopPropagation();
      setTargetsActive(false);
      setPreviewPosition(undefined);
      setArmedPosition(undefined);
      setTargetPositions([]);
    }
  };

  /**
   * Subscribes to a Dockview's drag, drop, and layout events and keeps the
   * edge drop affordance in sync with the pointer over `parent`. Returns a
   * disposable that releases the Dockview subscriptions.
   */
  const bind = (dockApi: DockviewApi, parent: HTMLElement) => {
    let holdTimeout: ReturnType<typeof setTimeout> | undefined;
    let holdPosition: DefaultEdgeGroupPosition | undefined;
    let previewStartedAt: number | undefined;
    let dragEndTarget: HTMLElement | undefined;

    /** Returns whether a release over `position` should land in its edge group. */
    const isDropCommitted = (
      position: DefaultEdgeGroupPosition,
      nativeEvent: EdgeDropPointerEvent,
    ) =>
      armedPosition() === position ||
      (previewPosition() === position &&
        previewStartedAt !== undefined &&
        performance.now() - previewStartedAt >= EDGE_DROP_HOLD_DELAY_MS) ||
      isEdgeDropModifierPressed(nativeEvent);

    const disposeEdgeDrop = dockApi.onWillDrop((event) => {
      if (event.kind !== "edge") return;
      if (!isDefaultEdgeGroupPosition(event.position)) return;
      if (!targetPositions().includes(event.position)) return;
      if (!isDropCommitted(event.position, event.nativeEvent)) return;

      if (
        movePanelTransferToDefaultEdgeGroup(
          dockApi,
          event.position,
          event.getData(),
        )
      ) {
        event.preventDefault();
      }
    });
    const disposeHideEmptyAfterRemove = dockApi.onDidRemovePanel(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    const disposeHideEmptyAfterMove = dockApi.onDidMovePanel(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    const disposeHideEmptyAfterRestore = dockApi.onDidLayoutFromJSON(() => {
      hideEmptyDefaultEdgeGroups(dockApi);
    });
    /** Refreshes resting insets after panels, visibility, or restored layouts change. */
    const syncHiddenEdgePositions = () => {
      setHiddenEdgePositions(getHiddenDefaultEdgeDropTargets(dockApi));
    };
    const disposeHiddenEdgePadding = dockApi.onDidLayoutChange(
      syncHiddenEdgePositions,
    );
    syncHiddenEdgePositions();

    /** Cancels a pending hold-to-arm timer. */
    const clearHold = () => {
      if (holdTimeout !== undefined) {
        clearTimeout(holdTimeout);
        holdTimeout = undefined;
      }
      holdPosition = undefined;
    };
    /** Drops the preview, hold timer, and armed band without hiding the bands. */
    const resetAffordance = () => {
      clearHold();
      setPreviewPosition(undefined);
      previewStartedAt = undefined;
      setArmedPosition(undefined);
    };
    /**
     * Tracks the band under the pointer: previews it, arms it immediately when
     * the modifier is held, or arms it after the hold delay otherwise.
     */
    const updateAffordance = (event: EdgeDropPointerEvent) => {
      if (!targetsActive()) return;

      const edgePosition = getEdgeDropPositionFromPoint(
        parent,
        event.clientX,
        event.clientY,
        targetPositions(),
      );
      if (!edgePosition) {
        resetAffordance();
        return;
      }

      if (previewPosition() !== edgePosition) {
        previewStartedAt = performance.now();
        setPreviewPosition(edgePosition);
      }
      if (armedPosition() && armedPosition() !== edgePosition) {
        setArmedPosition(undefined);
      }

      if (isEdgeDropModifierPressed(event)) {
        clearHold();
        setArmedPosition(edgePosition);
        return;
      }

      if (armedPosition() === edgePosition || holdPosition === edgePosition) {
        return;
      }

      clearHold();
      holdPosition = edgePosition;
      holdTimeout = setTimeout(() => {
        if (targetsActive() && previewPosition() === edgePosition) {
          setArmedPosition(edgePosition);
        }
        holdTimeout = undefined;
        holdPosition = undefined;
      }, EDGE_DROP_HOLD_DELAY_MS);
    };
    /** Window-level pointer and drag tracker installed for the duration of a drag. */
    const handleWindowDragTracking = (event: EdgeDropPointerEvent) => {
      updateAffordance(event);
    };
    /** Hides every band and removes the window and drag-source listeners of the drag. */
    const disableTargets = () => {
      setTargetsActive(false);
      resetAffordance();
      setTargetPositions([]);
      window.removeEventListener("dragover", handleWindowDragTracking, true);
      window.removeEventListener("pointermove", handleWindowDragTracking, true);
      window.removeEventListener("mousemove", handleWindowDragTracking, true);
      window.removeEventListener("mouseup", handleWindowDrop, true);
      window.removeEventListener("pointerup", handleWindowDrop, true);
      dragEndTarget?.removeEventListener("dragend", handleWindowDrop);
      dragEndTarget = undefined;
    };
    /** Commits a release over a band to its edge group, then ends the drag affordance. */
    const handleWindowDrop = (event: EdgeDropPointerEvent) => {
      if (!targetsActive()) return;

      const edgePosition = getEdgeDropPositionFromPoint(
        parent,
        event.clientX,
        event.clientY,
        targetPositions(),
      );
      if (
        edgePosition &&
        isDropCommitted(edgePosition, event) &&
        movePanelTransferToDefaultEdgeGroup(dockApi, edgePosition)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }

      disableTargets();
    };
    /** Exposes bands for hidden empty edges (other than the drag source) and starts tracking. */
    const enableTargets = (
      nativeEvent: DragEvent | PointerEvent,
      sourcePosition?: DefaultEdgeGroupPosition,
    ) => {
      const positions = getHiddenDefaultEdgeDropTargets(
        dockApi,
        sourcePosition,
      );
      setTargetPositions(positions);
      if (positions.length === 0) return;

      setTargetsActive(true);

      const target = nativeEvent.target;
      if (target instanceof HTMLElement) {
        dragEndTarget = target;
        target.addEventListener("dragend", handleWindowDrop, {
          once: true,
        });
      }
      window.addEventListener("dragover", handleWindowDragTracking, {
        capture: true,
      });
      window.addEventListener("pointermove", handleWindowDragTracking, {
        capture: true,
      });
      window.addEventListener("mousemove", handleWindowDragTracking, {
        capture: true,
      });
      window.addEventListener("mouseup", handleWindowDrop, {
        capture: true,
        once: true,
      });
      window.addEventListener("pointerup", handleWindowDrop, {
        capture: true,
        once: true,
      });
    };
    const disposeEnableOnPanelDrag = dockApi.onWillDragPanel((event) => {
      const location = event.panel.api.location;
      const sourcePosition =
        location.type === "edge" &&
        isDefaultEdgeGroupPosition(location.position)
          ? location.position
          : undefined;
      enableTargets(event.nativeEvent, sourcePosition);
    });
    const disposeEnableOnGroupDrag = dockApi.onWillDragGroup((event) => {
      const location = event.group.api.location;
      const sourcePosition =
        location.type === "edge" &&
        isDefaultEdgeGroupPosition(location.position)
          ? location.position
          : undefined;
      enableTargets(event.nativeEvent, sourcePosition);
    });
    const disposeDisableAfterDrop = dockApi.onDidDrop(disableTargets);

    return {
      /** Releases the Dockview subscriptions before the Dockview is disposed. */
      dispose() {
        disposeEdgeDrop.dispose();
        disposeHideEmptyAfterRemove.dispose();
        disposeHideEmptyAfterMove.dispose();
        disposeHideEmptyAfterRestore.dispose();
        disposeHiddenEdgePadding.dispose();
        disposeEnableOnPanelDrag.dispose();
        disposeEnableOnGroupDrag.dispose();
        disposeDisableAfterDrop.dispose();
      },
    };
  };

  return {
    targetsActive,
    armedPosition,
    targetPositions,
    hostStyle,
    handleZoneDragOver,
    handleZoneDrop,
    bind,
  };
}
