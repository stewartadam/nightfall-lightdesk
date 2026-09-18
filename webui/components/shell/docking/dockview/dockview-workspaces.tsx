// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, For, onCleanup, untrack } from "solid-js";
import {
  createSerializedLayout,
  type SerializedLayout,
} from "../../../../lib/dockview-layout";
import { registerLayoutActivator } from "../../../../lib/layout-activation";
import { initializeNamedLayout } from "../../../../lib/layout-management";
import {
  commitActiveLayout,
  getActiveStoredLayoutId,
  getShowfilePanelLayouts,
  getStoredLayout,
} from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import { setStoreAction } from "../../../../lib/nanostore-action";
import { currentShowfileRevision } from "../../../../lib/showfile-loading";
import { WorkspaceActivityContext } from "../../../../lib/workspace-activity";
import { dockApi } from "../../../../state/appStores";
import {
  activeLayoutId,
  getLayoutSession,
  layoutEditPending,
  onLayoutSessionInvalidated,
  rememberLayoutSession,
} from "../../../../state/layout-switcher";
import { $settings } from "../../../../state/settings";
import { useAppShell } from "../../../providers/app-shell";
import { ModalVisibilityContext } from "../../../ui/modal";
import {
  dockviewLayoutSettingsSnapshotRevision,
  dockviewLayoutShowfileRevision,
} from "../layout-readiness";
import DockWorkspace, { type DockWorkspaceHandle } from "./dockview-app";
import { DockviewCommands } from "./dockview-commands";
import { DockviewEventListener } from "./dockview-event-listener";

import { createLayoutEntrance } from "./layout-entrance";

const log = getLogger(import.meta.url);

interface Workspace {
  layoutId?: string;
  initialLayout?: SerializedLayout;
  restoreSession?: boolean;
  handle?: DockWorkspaceHandle;
  element?: HTMLDivElement;
  ready: Promise<DockWorkspaceHandle>;
  resolve: (handle: DockWorkspaceHandle) => void;
  reject: (error: unknown) => void;
}

/** Creates a lazy workspace record whose readiness includes Dockview deserialization. */
function workspace(
  initialLayout?: SerializedLayout,
  layoutId?: string,
): Workspace {
  let resolve!: (handle: DockWorkspaceHandle) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DockWorkspaceHandle>(
    (resolveReady, rejectReady) => {
      resolve = resolveReady;
      reject = rejectReady;
    },
  );
  return { initialLayout, layoutId, ready: promise, resolve, reject };
}

/** Retains visited layout workspaces and publishes only the active API to the application shell. */
export default function DockWorkspaces() {
  const shell = useAppShell();
  const initial = workspace();
  initial.restoreSession = true;
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([initial]);
  const [active, setActive] = createSignal<Workspace | null>(initial);
  const [presented, setPresented] = createSignal<Workspace>(initial);
  let current = initial;
  const [switching, setSwitching] = createSignal(false);
  let disposed = false;
  let generation = 0;
  let entrance: Animation | undefined;
  let entranceFrame: number | undefined;
  let disposeEntrance: (() => void) | undefined;

  /** Cancels pending motion when another workspace takes over or the owner unmounts. */
  const cancelEntrance = () => {
    if (entranceFrame !== undefined) cancelAnimationFrame(entranceFrame);
    entranceFrame = undefined;
    entrance?.cancel();
    entrance = undefined;
    disposeEntrance?.();
    disposeEntrance = undefined;
  };

  /** Retires the outgoing visual layer and removes workspaces with no retained layout. */
  const finishPresentation = () => {
    if (switching()) return;
    setPresented(current);
    setWorkspaces((entries) =>
      entries.filter(
        (entry) =>
          entry === current ||
          (!!entry.layoutId && entry.layoutId !== current.layoutId),
      ),
    );
  };

  /** Starts motion on a fresh frame so activation work cannot consume the visible transition. */
  const animateEntrance = (entry: Workspace, direction: number) => {
    cancelEntrance();
    if (
      !entry.element ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finishPresentation();
      return;
    }
    const transition = createLayoutEntrance(entry.element, direction);
    if (!transition) {
      finishPresentation();
      return;
    }
    const { animation, dispose } = transition;
    disposeEntrance = dispose;
    entrance = animation;
    void animation.finished.then(
      () => {
        if (entrance === animation) {
          cancelEntrance();
          finishPresentation();
        }
      },
      () => {},
    );
    animation.pause();
    animation.currentTime = 0;
    entranceFrame = requestAnimationFrame(() => {
      entranceFrame = undefined;
      animation.play();
    });
  };

  /** Publishes a mounted workspace and derives its entrance direction from the current tab order. */
  const publish = (entry: Workspace) => {
    const layouts = getShowfilePanelLayouts().filter(
      (layout) => layout.shownInSwitcher,
    );
    const sourceIndex = layouts.findIndex(
      (layout) => layout.id === current.layoutId,
    );
    const targetIndex = layouts.findIndex(
      (layout) => layout.id === entry.layoutId,
    );
    const direction =
      sourceIndex < 0 || targetIndex < 0
        ? 0
        : Math.sign(targetIndex - sourceIndex);
    current = entry;
    setActive(entry);
    setStoreAction(dockApi, "Activate layout workspace", entry.handle!.api);
    shell.setDockviewApi(entry.handle!.api);
    animateEntrance(entry, direction);
  };

  /** Drops cached views on reset and showfile changes, retaining an unassigned active arrangement. */
  onCleanup(
    onLayoutSessionInvalidated((layoutId) => {
      generation += 1;
      if (layoutId === undefined || current.layoutId === layoutId)
        current.layoutId = undefined;
      setWorkspaces((entries) =>
        entries.filter((entry) => {
          const keep =
            entry === current ||
            (layoutId !== undefined && entry.layoutId !== layoutId);
          if (!keep && !entry.handle)
            entry.reject(
              new Error("Workspace invalidated before initialization"),
            );
          return keep;
        }),
      );
    }),
  );

  onCleanup(
    registerLayoutActivator(async (api, layoutId, options) => {
      if (switching() || current.handle?.api !== api) return false;
      const saved = getStoredLayout(layoutId);
      if (!saved) return false;
      if (options.adoptCurrent) {
        const snapshot = createSerializedLayout(api);
        if (!commitActiveLayout(layoutId, snapshot)) return false;
        current.layoutId = layoutId;
        rememberLayoutSession(layoutId, snapshot);
        activeLayoutId.set(layoutId);
        return true;
      }
      setSwitching(true);
      const startedGeneration = generation;
      const previous = current;

      let target = !options.reset
        ? workspaces().find((entry) => entry.layoutId === layoutId)
        : undefined;
      const created = !target;
      const restoringSaved =
        created && (options.reset || !getLayoutSession(layoutId));
      try {
        const snapshot = createSerializedLayout(api);
        if (previous.layoutId)
          rememberLayoutSession(previous.layoutId, snapshot);
        // Release duplicate-ID commands and properties before mounting another workspace.
        cancelEntrance();
        setPresented(previous);
        setActive(null);
        if (!target) {
          target = workspace(
            !options.reset ? (getLayoutSession(layoutId) ?? saved) : saved,
            layoutId,
          );
          setWorkspaces((entries) => [...entries, target!]);
        }
        await target.ready;
        if (generation !== startedGeneration)
          throw new Error("Layout context changed while switching");
        activeLayoutId.set(layoutId);
        publish(target);
        const targetLayout = createSerializedLayout(target.handle!.api);
        if (!commitActiveLayout(layoutId, targetLayout))
          throw new Error("Could not persist layout selection");
        if (previous !== target && previous.layoutId === target.layoutId)
          previous.layoutId = undefined;
        rememberLayoutSession(
          layoutId,
          targetLayout,
          restoringSaved ? saved : undefined,
        );
        return true;
      } catch (error) {
        log.error("Could not activate layout workspace", error);
        if (created)
          setWorkspaces((entries) =>
            entries.filter((entry) => entry !== target),
          );
        if (!disposed) {
          activeLayoutId.set(previous.layoutId ?? null);
          publish(previous);
        }
        return false;
      } finally {
        setSwitching(false);
        if (!entrance) finishPresentation();
      }
    }),
  );

  const editingLayouts = useStore(layoutEditPending);
  const restoredRevision = useStore(dockviewLayoutShowfileRevision);
  const restoredSettings = useStore(dockviewLayoutSettingsSnapshotRevision);
  const showfileRevision = useStore(currentShowfileRevision);
  let initializedRevision = -1;
  /** Establishes one named active layout after the showfile arrangement has finished restoring. */
  createEffect(() => {
    const revision = restoredRevision();
    if (
      editingLayouts() ||
      !restoredSettings() ||
      revision !== showfileRevision() ||
      initializedRevision === revision
    )
      return;
    const api = shell.dockviewApi();
    if (!api) return;
    initializedRevision = revision;
    const preferred = untrack(
      () =>
        $settings.get().active_panel_layout?.layoutId ??
        getActiveStoredLayoutId(),
    );
    void initializeNamedLayout(
      api,
      preferred,
      Boolean($settings.get().active_panel_layout),
    ).then((initialized) => {
      if (!initialized && initializedRevision === revision)
        initializedRevision = -1;
    });
  });

  /** Releases shell references after all owned Dockviews are torn down. */
  onCleanup(() => {
    disposed = true;
    cancelEntrance();
    generation += 1;
    for (const entry of workspaces()) {
      if (!entry.handle && entry !== initial)
        entry.reject(new Error("Workspace owner disposed"));
    }
    setStoreAction(dockApi, "Unmount layout workspaces", undefined);
    shell.setDockviewApi(undefined);
  });

  return (
    <div class="relative h-full min-h-0 w-full">
      <For each={workspaces()}>
        {(entry) => {
          /** Supplies a stable identity as well as reactive activity to workspace-owned hooks. */
          const isActive = () => active() === entry;
          /** Keeps the inactive outgoing view painted until the incoming slide completes. */
          const isPresented = () => isActive() || presented() === entry;
          const [ready, setReady] = createSignal(false);
          return (
            <WorkspaceActivityContext.Provider value={isActive}>
              <ModalVisibilityContext.Provider value={isActive}>
                <div
                  ref={(element) => {
                    entry.element = element;
                  }}
                  class="nf-layout-workspace absolute inset-0"
                  data-layout-workspace
                  data-workspace-active={isActive()}
                  aria-hidden={!isActive()}
                  inert={!isActive() || switching()}
                  style={{
                    display: isPresented() || !ready() ? undefined : "none",
                    visibility: isPresented() ? "visible" : "hidden",
                    "z-index": isActive() ? 1 : 0,
                    background: "#101112",
                    "pointer-events": isActive() ? "auto" : "none",
                  }}
                >
                  <DockWorkspace
                    initialLayout={entry.initialLayout}
                    restoreSession={entry.restoreSession}
                    onReady={(handle) => {
                      entry.handle = handle;
                      setReady(true);
                      entry.resolve(handle);
                      if (entry === initial && current === initial)
                        publish(entry);
                    }}
                    onError={entry.reject}
                  />
                </div>
              </ModalVisibilityContext.Provider>
            </WorkspaceActivityContext.Provider>
          );
        }}
      </For>
      <DockviewEventListener
        isActivating={switching}
        hasSessionLayout={() => current.handle?.hasSessionLayout() ?? false}
        onResetLayout={() => current.handle?.reset()}
      />
      <DockviewCommands onResetLayout={() => current.handle?.reset()} />
    </div>
  );
}
