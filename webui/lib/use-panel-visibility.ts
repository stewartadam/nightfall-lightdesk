// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewPanelApi } from "dockview";
import { type Accessor, createSignal, onCleanup } from "solid-js";

import { useWorkspaceActivity } from "./workspace-activity";

/**
 * Tracks whether Dockview renders a panel as the visible tab in its group.
 * Components outside Dockview remain visible so standalone use keeps its
 * existing behavior.
 */
export function usePanelVisibility(
  panelApi: DockviewPanelApi | undefined,
): Accessor<boolean> {
  const workspaceActive = useWorkspaceActivity();
  /** Reads the current Dockview tab visibility without requiring global panel focus. */
  const readVisibility = () => panelApi === undefined || panelApi.isVisible;
  const [isVisible, setIsVisible] = createSignal(readVisibility());

  if (!panelApi) {
    return () => workspaceActive() && isVisible();
  }

  const visibilitySubscription = panelApi.onDidVisibilityChange((event) => {
    setIsVisible(event.isVisible);
  });

  onCleanup(() => {
    visibilitySubscription.dispose();
  });

  return () => workspaceActive() && isVisible();
}
