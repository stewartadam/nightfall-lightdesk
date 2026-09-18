// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DockviewPanelApi, VisibilityEvent } from "dockview";
import { createRoot } from "solid-js";
import { usePanelVisibility } from "./use-panel-visibility";

/** Verifies visible tabs remain subscribed when another Dockview group owns global focus. */
test("usePanelVisibility follows tab visibility instead of global active state", () => {
  let visibilityListener: ((event: VisibilityEvent) => void) | undefined;
  let subscriptionDisposed = false;
  const panelApi = {
    isActive: false,
    isVisible: true,
    onDidVisibilityChange: (listener: (event: VisibilityEvent) => void) => {
      visibilityListener = listener;
      return {
        dispose: () => {
          subscriptionDisposed = true;
        },
      };
    },
  } as unknown as DockviewPanelApi;

  createRoot((dispose) => {
    const isVisible = usePanelVisibility(panelApi);

    assert.equal(isVisible(), true);

    visibilityListener?.({ isVisible: false });
    assert.equal(isVisible(), false);

    visibilityListener?.({ isVisible: true });
    assert.equal(isVisible(), true);

    dispose();
  });

  assert.equal(subscriptionDisposed, true);
});

/** Workspace activity overrides a visible Dockview tab and restores it without resubscribing. */
test("workspace suspension overrides panel visibility without recreating its subscription", async () => {
  const { createComponent, createSignal } = await import("solid-js");
  const { WorkspaceActivityContext } = await import("./workspace-activity");
  let subscriptions = 0;
  createRoot((dispose) => {
    const [active, setActive] = createSignal(true);
    let visible!: () => boolean;
    createComponent(WorkspaceActivityContext.Provider, {
      value: active,
      get children() {
        visible = usePanelVisibility({
          isVisible: true,
          onDidVisibilityChange: () => {
            subscriptions += 1;
            return { dispose() {} };
          },
        } as unknown as DockviewPanelApi);
        return null;
      },
    });
    assert.equal(visible(), true);
    setActive(false);
    assert.equal(visible(), false);
    setActive(true);
    assert.equal(visible(), true);
    assert.equal(subscriptions, 1);
    dispose();
  });
});
