// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type DockviewApi,
  DockviewCompositeDisposable,
  type DockviewGroupPanel,
  type EdgeGroupPosition,
} from "dockview";
import { createEffect, onCleanup } from "solid-js";
import {
  activeLayoutKey,
  activeLayoutToSerializedLayout,
} from "../../../../lib/dockview-active-layout";
import {
  createSerializedLayout,
  restoreSerializedLayout,
  type SerializedLayout,
} from "../../../../lib/dockview-layout";
import { saveLayout } from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import { currentShowfileRevision } from "../../../../lib/showfile-loading";
import {
  activeLayoutId,
  clearLayoutSessions,
  rememberLayoutResize,
  rememberLayoutSession,
} from "../../../../state/layout-switcher";
import {
  $settings,
  $settingsSnapshotRevision,
} from "../../../../state/settings";
import { useAppShell } from "../../../providers/app-shell";
import { markDockviewLayoutReady } from "../layout-readiness";

const log = getLogger(import.meta.url);

const EDGE_GROUP_SIZE_TARGETS = [
  {
    position: "left",
    testId: "dv-edge-group-edge-Programmer",
  },
  {
    position: "bottom",
    testId: "dv-edge-group-edge-Console",
  },
  {
    position: "right",
    testId: "dv-edge-group-edge-Properties",
  },
] as const satisfies readonly {
  position: EdgeGroupPosition;
  testId: string;
}[];

interface DockviewEventListenerProps {
  isActivating?: () => boolean;
  hasSessionLayout?: () => boolean;
  onResetLayout?: () => void;
}

interface Disposable {
  dispose(): void;
}

/** Returns whether an element should keep text-editing focus during panel activation. */
function isEditableFocusTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Focuses the docked command input only when activation would otherwise have no editor target. */
function focusCommandLinePanelInputIfNeeded(): void {
  if (isEditableFocusTarget(document.activeElement)) {
    return;
  }

  document
    .querySelector<HTMLElement>('[data-workspace-active="true"] #cmdline')
    ?.focus();
}

/**
 * Persists edge-group-only size changes that Dockview may not report as layout changes.
 */
function createEdgeGroupSizePersistence(
  api: DockviewApi,
  scheduleSave: () => void,
): Disposable {
  if (typeof ResizeObserver === "undefined") {
    return { dispose: () => {} };
  }

  const observedElements = new Set<Element>();
  const observedSizes = new Map<Element, string>();

  /** Returns a stable string key for the observed edge group dimensions. */
  const resizeEntryKey = (entry: ResizeObserverEntry) =>
    `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;

  const resizeObserver = new ResizeObserver((entries) => {
    let didResize = false;
    for (const entry of entries) {
      const nextSize = resizeEntryKey(entry);
      const previousSize = observedSizes.get(entry.target);
      observedSizes.set(entry.target, nextSize);
      if (previousSize !== undefined && previousSize !== nextSize) {
        didResize = true;
      }
    }

    if (didResize) {
      scheduleSave();
    }
  });
  /** Observes any rendered edge-group shells that can resize outside Dockview events. */
  const observeEdgeGroups = () => {
    for (const target of EDGE_GROUP_SIZE_TARGETS) {
      const element = document.querySelector(
        `[data-workspace-active="true"] [data-testid="${target.testId}"]`,
      );
      if (element && !observedElements.has(element)) {
        observedElements.add(element);
        resizeObserver.observe(element);
      }
    }
  };
  const mutationObserver = new MutationObserver(observeEdgeGroups);
  const collapsedDisposables = EDGE_GROUP_SIZE_TARGETS.flatMap((target) => {
    const edgeGroup = api.getEdgeGroup(target.position);
    return edgeGroup ? [edgeGroup.onDidCollapsedChange(scheduleSave)] : [];
  });

  observeEdgeGroups();
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return {
    dispose: () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      for (const disposable of collapsedDisposables) {
        disposable.dispose();
      }
    },
  };
}

/** Handles Dockview focus, restore, and showfile-backed layout persistence events. */
export function DockviewEventListener(props: DockviewEventListenerProps) {
  log.trace("mounting");
  const { dockviewApi } = useAppShell();
  const settings = useStore($settings);
  const settingsSnapshotRevision = useStore($settingsSnapshotRevision);
  const showfileRevision = useStore(currentShowfileRevision);
  let hasInitializedLayout = false;
  let isRestoringLayout = false;
  let lastRestoredLayoutKey: string | null = null;
  let lastRestoredShowfileRevision = -1;

  /** Restores the showfile-backed active layout when settings snapshots change. */
  createEffect(() => {
    const api = dockviewApi();
    if (!api) return;

    const snapshotRevision = settingsSnapshotRevision();
    if (snapshotRevision === 0) return;

    const currentShowfileRevisionValue = showfileRevision();
    if (currentShowfileRevisionValue !== lastRestoredShowfileRevision) {
      clearLayoutSessions();
    }
    const activeLayout = settings().active_panel_layout;
    const nextLayoutKey = activeLayoutKey(activeLayout);
    if (!activeLayout) {
      if (!hasInitializedLayout && props.hasSessionLayout?.()) {
        hasInitializedLayout = true;
        lastRestoredLayoutKey = null;
        lastRestoredShowfileRevision = currentShowfileRevisionValue;
        markDockviewLayoutReady(
          currentShowfileRevisionValue,
          snapshotRevision,
          nextLayoutKey,
        );
        return;
      }

      if (
        !hasInitializedLayout ||
        currentShowfileRevisionValue !== lastRestoredShowfileRevision
      ) {
        log.debug("No showfile active layout found, using default layout");
        props.onResetLayout?.();
        saveLayout(api);
        hasInitializedLayout = true;
      }
      lastRestoredLayoutKey = null;
      lastRestoredShowfileRevision = currentShowfileRevisionValue;
      markDockviewLayoutReady(
        currentShowfileRevisionValue,
        snapshotRevision,
        nextLayoutKey,
      );
      return;
    }

    if (
      nextLayoutKey === lastRestoredLayoutKey &&
      currentShowfileRevisionValue === lastRestoredShowfileRevision
    ) {
      hasInitializedLayout = true;
      lastRestoredLayoutKey = nextLayoutKey;
      markDockviewLayoutReady(
        currentShowfileRevisionValue,
        snapshotRevision,
        nextLayoutKey,
      );
      return;
    }

    try {
      isRestoringLayout = true;
      log.debug("Restoring active layout from showfile settings");
      restoreSerializedLayout(
        api,
        activeLayoutToSerializedLayout(activeLayout),
      );
      lastRestoredLayoutKey = nextLayoutKey;
      lastRestoredShowfileRevision = currentShowfileRevisionValue;
      hasInitializedLayout = true;
      saveLayout(api);
    } catch (error) {
      log.error("Error restoring showfile active layout:", error);
      props.onResetLayout?.();
      lastRestoredLayoutKey = nextLayoutKey;
      lastRestoredShowfileRevision = currentShowfileRevisionValue;
      hasInitializedLayout = true;
      saveLayout(api);
    } finally {
      markDockviewLayoutReady(
        currentShowfileRevisionValue,
        snapshotRevision,
        nextLayoutKey,
      );
      window.queueMicrotask(() => {
        isRestoringLayout = false;
      });
    }
  });

  /** Registers Dockview persistence and focus listeners. */
  createEffect(() => {
    const api = dockviewApi();
    if (!api) return;

    /** Persists the current Dockview layout to local session storage. */
    const persistActiveLayout = () => {
      if (isRestoringLayout || props.isActivating?.()) return;
      saveLayout(api);
      const id = activeLayoutId.get();
      if (id) rememberLayoutSession(id, createSerializedLayout(api));
    };

    let saveQueued = false;
    let disposed = false;
    let geometryGesture:
      | { id: string; before: SerializedLayout; pointerId: number }
      | undefined;
    /** Captures explicit Dockview divider, floating resize, and floating move gestures before geometry changes. */
    const beginGeometryGesture = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        props.isActivating?.() ||
        !(event.target instanceof Element)
      )
        return;
      const target = event.target;
      if (!target.closest('[data-workspace-active="true"]')) return;
      const handle = target.closest(
        '.dv-sash, [class*="dv-resize-handle-"], .dv-floating-titlebar, .dv-resize-container .dv-tabs-and-actions-container',
      );
      if (
        !handle &&
        !(event.shiftKey && target.closest(".dv-resize-container"))
      )
        return;
      const id = activeLayoutId.get();
      if (id)
        geometryGesture = {
          id,
          before: createSerializedLayout(api),
          pointerId: event.pointerId,
        };
    };
    /** Commits only geometry changed during the gesture after Dockview processes its final pointer event. */
    const endGeometryGesture = (event: PointerEvent) => {
      const gesture = geometryGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      geometryGesture = undefined;
      queueMicrotask(() => {
        if (!disposed) {
          rememberLayoutResize(
            gesture.id,
            gesture.before,
            createSerializedLayout(api),
          );
          saveLayout(api);
        }
      });
    };
    window.addEventListener("pointerdown", beginGeometryGesture, true);
    window.addEventListener("pointerup", endGeometryGesture);
    window.addEventListener("pointercancel", endGeometryGesture);
    /** Coalesces layout changes and captures sizes after Dockview finishes the operation. */
    const saveActiveLayout = () => {
      if (!hasInitializedLayout || isRestoringLayout || saveQueued) return;
      saveQueued = true;
      window.queueMicrotask(() => {
        saveQueued = false;
        if (!disposed) persistActiveLayout();
      });
    };

    // Structural mutations exclude focus changes, but do not include resizing.
    const groupLayoutListeners = new Map<string, Disposable>();
    /** Tracks resizing and serialized panel metadata for current and newly restored groups. */
    const observeGroupLayout = (group: DockviewGroupPanel) => {
      groupLayoutListeners.get(group.id)?.dispose();
      groupLayoutListeners.set(
        group.id,
        new DockviewCompositeDisposable(
          group.api.onDidDimensionsChange(saveActiveLayout),
          group.model.onDidPanelTitleChange(saveActiveLayout),
          group.model.onDidPanelParametersChange(saveActiveLayout),
        ),
      );
    };
    for (const group of api.groups) observeGroupLayout(group);
    /** Reads floating window bounds, whose movement has no dedicated public API event. */
    const floatingBounds = () =>
      api.groups.some((group) => group.api.location.type === "floating")
        ? JSON.stringify(
            api.toJSON().floatingGroups?.map((group) => group.position),
          )
        : undefined;
    let lastFloatingBounds = floatingBounds();
    const disposeLayoutChange = new DockviewCompositeDisposable(
      api.onDidMutateLayout(saveActiveLayout),
      api.onDidLayoutChange(() => {
        const nextFloatingBounds = floatingBounds();
        if (nextFloatingBounds === lastFloatingBounds) return;
        lastFloatingBounds = nextFloatingBounds;
        saveActiveLayout();
      }),
      api.onDidAddGroup(observeGroupLayout),
      api.onDidRemoveGroup((group) => {
        groupLayoutListeners.get(group.id)?.dispose();
        groupLayoutListeners.delete(group.id);
      }),
      api.onDidPopoutGroupSizeChange(saveActiveLayout),
      api.onDidPopoutGroupPositionChange(saveActiveLayout),
      api.onDidPanelPinnedChange(saveActiveLayout),
      api.onDidTabGroupChange(saveActiveLayout),
      api.onDidTabGroupCollapsedChange(saveActiveLayout),
    );

    const disposeFocusChange = api.onDidActivePanelChange((event) => {
      // TODO: ideally we would pass on this notification to the underlying component
      if (event.panel?.id === "panel-CommandLine") {
        focusCommandLinePanelInputIfNeeded();
      }
    });
    const disposeEdgeGroupSizePersistence = createEdgeGroupSizePersistence(
      api,
      saveActiveLayout,
    );

    // Clean up event listeners on unmount
    onCleanup(() => {
      log.trace("unmounting");
      disposed = true;
      window.removeEventListener("pointerdown", beginGeometryGesture, true);
      window.removeEventListener("pointerup", endGeometryGesture);
      window.removeEventListener("pointercancel", endGeometryGesture);
      disposeLayoutChange.dispose();
      for (const listener of groupLayoutListeners.values()) listener.dispose();
      disposeFocusChange.dispose();
      disposeEdgeGroupSizePersistence.dispose();
    });
  });

  // This component doesn't render anything
  return null;
}
