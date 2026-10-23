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
  createSerializedLayout,
  type SerializedLayout,
} from "../../../../lib/dockview-layout";
import { hasSessionLayoutFor, saveLayout } from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import {
  currentShowfileName,
  currentShowfileRevision,
} from "../../../../lib/showfile-loading";
import {
  activeLayoutId,
  clearLayoutSessions,
  rememberLayoutResize,
  rememberLayoutSession,
} from "../../../../state/layout-switcher";
import { $settingsSnapshotRevision } from "../../../../state/settings";
import { useAppShell } from "../../../providers/app-shell";
import { markDockviewLayoutReady } from "../layout-readiness";

const log = getLogger(import.meta.url);

const EDGE_GROUP_SIZE_TARGETS = [
  {
    position: "left",
    testId: "dv-edge-group-edge-Clips",
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
  /** Saves the arrangement as the local session; false for views that only present it. */
  persist?: boolean;
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

/**
 * The showfile revision whose arrangement this tab already settled on. It
 * outlives one listener, so remounting the workspace when the shell switches
 * between docked and compact keeps the arrangement instead of starting over.
 */
const appliedShowfile: { revision: number; keptDeviceArrangement: boolean } = {
  revision: -1,
  keptDeviceArrangement: false,
};

/** Handles Dockview focus, restore, and showfile-backed layout persistence events. */
export function DockviewEventListener(props: DockviewEventListenerProps) {
  log.trace("mounting");
  const { dockviewApi } = useAppShell();
  const settingsSnapshotRevision = useStore($settingsSnapshotRevision);
  const showfileRevision = useStore(currentShowfileRevision);
  let hasInitializedLayout = false;
  let isRestoringLayout = false;

  /** Saves the arrangement as the local session, unless this view only presents it. */
  const persistSession = (api: DockviewApi) => {
    if (props.persist !== false) saveLayout(api);
  };

  /**
   * Settles this device's arrangement once per loaded showfile. The device keeps
   * its own arrangement when it already has one for this showfile; otherwise it
   * starts from the built-in arrangement and the workspace opens the showfile's
   * default named layout. Settings snapshots from other devices never rearrange
   * this one.
   */
  createEffect(() => {
    const api = dockviewApi();
    if (!api) return;

    const snapshotRevision = settingsSnapshotRevision();
    if (snapshotRevision === 0) return;

    const revision = showfileRevision();
    if (revision !== appliedShowfile.revision) {
      clearLayoutSessions();
      const keep =
        hasSessionLayoutFor(currentShowfileName.get()) &&
        (hasInitializedLayout || Boolean(props.hasSessionLayout?.()));
      if (!keep) {
        isRestoringLayout = true;
        log.debug("No arrangement on this device for the showfile");
        props.onResetLayout?.();
        persistSession(api);
        window.queueMicrotask(() => {
          isRestoringLayout = false;
        });
      }
      appliedShowfile.revision = revision;
      appliedShowfile.keptDeviceArrangement = keep;
    }
    hasInitializedLayout = true;
    markDockviewLayoutReady(
      revision,
      snapshotRevision,
      appliedShowfile.keptDeviceArrangement,
    );
  });

  /** Registers Dockview layout persistence listeners. */
  createEffect(() => {
    const api = dockviewApi();
    if (!api || props.persist === false) return;

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
        try {
          // Serialization temporarily restores maximized groups and emits resize events.
          // Keep the save queued until it finishes so those events cannot queue another save.
          if (!disposed) persistActiveLayout();
        } finally {
          saveQueued = false;
        }
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
      disposeEdgeGroupSizePersistence.dispose();
    });
  });

  /** Moves keyboard focus into the command line when its panel is activated. */
  createEffect(() => {
    const api = dockviewApi();
    if (!api) return;
    const disposeFocusChange = api.onDidActivePanelChange((event) => {
      // TODO: ideally we would pass on this notification to the underlying component
      if (event.panel?.id === "panel-CommandLine") {
        focusCommandLinePanelInputIfNeeded();
      }
    });
    onCleanup(() => disposeFocusChange.dispose());
  });

  // This component doesn't render anything
  return null;
}
