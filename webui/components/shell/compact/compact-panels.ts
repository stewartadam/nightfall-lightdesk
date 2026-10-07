// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { getComponentRegistration } from "../../../lib/panel-registry";
import type { AppIcon } from "../../ui/icon";
import { compactPanelOrder } from "../docking/dockview/compact-presentation";
import {
  COMPACT_PINNED_TAB_COUNT,
  compactPanelOrderPreference,
  moveCompactPanel,
  orderCompactPanelIds,
  savedCompactPanelOrder,
} from "./compact-panel-order";

/** One open panel as the compact navigation presents it. */
export interface CompactPanelEntry {
  readonly id: string;
  readonly title: string;
  readonly icon?: AppIcon;
}

/** Open panels in navigation order and the panel currently shown. */
export interface CompactPanels {
  /** Open panels in the operator's order; the first ones are the pinned tabs. */
  readonly panels: Accessor<readonly CompactPanelEntry[]>;
  /** The leading panels shown as tabs in the tab bar. */
  readonly pinned: Accessor<readonly CompactPanelEntry[]>;
  readonly activeId: Accessor<string | undefined>;
  /** Moves a panel to a position in the order, pinning or unpinning it. */
  move: (id: string, toIndex: number) => void;
  /** Shows a panel by ID. */
  show: (id: string) => void;
  /** Shows the panel `offset` places away from the current one, if there is one. */
  step: (offset: number) => boolean;
  /** Closes a panel by ID. */
  close: (id: string) => void;
}

/**
 * Tracks the panels of the active workspace for the compact shell's navigation,
 * following opens, closes, moves, title changes and restored layouts.
 */
export function createCompactPanels(
  api: Accessor<DockviewApi | undefined>,
): CompactPanels {
  const [panels, setPanels] = createSignal<readonly CompactPanelEntry[]>([]);
  const [activeId, setActiveId] = createSignal<string>();

  /** Rebuilds the entries from Dockview so order always matches the folded group. */
  createEffect(() => {
    const dock = api();
    if (!dock) {
      setPanels([]);
      setActiveId(undefined);
      return;
    }
    /** Reads panel order, titles and the active panel from Dockview. */
    const refresh = () => {
      // Unchanged entries keep their identity so Solid keeps their tab and
      // sheet row mounted, along with any keyboard focus inside them.
      // Dockview can report changes from inside another computation, so the
      // read is untracked to keep this refresh from subscribing to itself.
      const previous = new Map(
        untrack(panels).map((entry) => [entry.id, entry]),
      );
      const dockPanels = compactPanelOrder(dock);
      const byId = new Map(dockPanels.map((panel) => [panel.id, panel]));
      const orderedIds = orderCompactPanelIds(
        dockPanels.map((panel) => panel.id),
        savedCompactPanelOrder(),
      );
      setPanels(
        orderedIds.flatMap((id) => {
          const panel = byId.get(id);
          if (!panel) return [];
          const title = panel.title ?? panel.id;
          const icon = getComponentRegistration(
            panel.view.contentComponent,
          )?.icon;
          const existing = previous.get(panel.id);
          return existing?.title === title && existing.icon === icon
            ? existing
            : { id: panel.id, title, icon };
        }),
      );
      setActiveId(dock.activePanel?.id);
    };
    const titleListeners = new Map<string, { dispose(): void }>();
    /** Follows title changes of every open panel, such as an editor's object name. */
    const syncTitleListeners = () => {
      const open = new Set(dock.panels.map((panel) => panel.id));
      for (const [id, listener] of titleListeners) {
        if (open.has(id)) continue;
        listener.dispose();
        titleListeners.delete(id);
      }
      for (const panel of dock.panels) {
        if (!titleListeners.has(panel.id))
          titleListeners.set(panel.id, panel.api.onDidTitleChange(refresh));
      }
    };
    /** Refreshes entries and title listeners after a structural change. */
    const onStructureChange = () => {
      syncTitleListeners();
      // Folding runs in a microtask after Dockview's own event, so read the
      // order once it has settled.
      queueMicrotask(refresh);
    };
    const subscriptions = [
      dock.onDidAddPanel(onStructureChange),
      dock.onDidRemovePanel(onStructureChange),
      dock.onDidMovePanel(onStructureChange),
      dock.onDidLayoutFromJSON(onStructureChange),
      dock.onDidActivePanelChange(refresh),
    ];
    const stopOrderListener = compactPanelOrderPreference.listen(refresh);
    onStructureChange();
    onCleanup(() => {
      stopOrderListener();
      for (const subscription of subscriptions) subscription.dispose();
      for (const listener of titleListeners.values()) listener.dispose();
    });
  });

  /** Activates a panel through Dockview so focus and Properties follow it. */
  const show = (id: string) => {
    api()?.getPanel(id)?.api.setActive();
  };

  /** The leading entries that fit in the tab bar. */
  const pinned = createMemo(() => panels().slice(0, COMPACT_PINNED_TAB_COUNT));

  return {
    panels,
    pinned,
    activeId,
    show,
    move: (id, toIndex) => {
      compactPanelOrderPreference.set(
        moveCompactPanel(
          panels().map((panel) => panel.id),
          savedCompactPanelOrder(),
          id,
          toIndex,
        ),
      );
    },
    step: (offset) => {
      const list = panels();
      const index = list.findIndex((panel) => panel.id === activeId());
      const next = list[index + offset];
      if (index < 0 || !next) return false;
      show(next.id);
      return true;
    },
    close: (id) => {
      api()?.getPanel(id)?.api.close();
    },
  };
}
