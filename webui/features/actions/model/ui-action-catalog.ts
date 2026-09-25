// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo } from "solid-js";
import {
  type UiAction,
  uiActionId,
  $uiActions as uiActionsStore,
} from "../../../components/providers/command-registry";
import { actionCatalog } from "../../../state/appStores";
import * as types from "../../../types";

/**
 * Describes client-hosted UI actions as catalog entries so they can be bound like backend actions.
 *
 * UI actions take no arguments and fire once, on a control's press or its release.
 */
export function uiActionCatalogEntries(
  actions: readonly UiAction[],
): types.ActionCatalogEntry[] {
  return actions.map((action) => ({
    descriptor: {
      id: uiActionId(action),
      label: action.name,
      category: `UI: ${action.category ?? "General"}`,
      description: action.description,
      input: types.ActionInputKind.Trigger,
      parameters: [],
    },
    capabilities: [],
    behaviors: [types.ControlBehavior.Press, types.ControlBehavior.Release],
  }));
}

/** Tracks every action this client can bind: the backend catalog plus local UI actions. */
export function useBindableActionCatalog(): Accessor<
  types.ActionCatalogEntry[]
> {
  const $backendCatalog = useStore(actionCatalog);
  const $uiActions = useStore(uiActionsStore);
  return createMemo(() => [
    ...$backendCatalog(),
    ...uiActionCatalogEntries($uiActions()),
  ]);
}
