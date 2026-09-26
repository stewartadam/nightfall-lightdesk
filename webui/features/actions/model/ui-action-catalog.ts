// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { type Accessor, createMemo } from "solid-js";
import {
  type UiActionDescriptor,
  $uiActionCatalog as uiActionCatalogStore,
  uiActionId,
} from "../../../components/providers/command-registry";
import { actionCatalog } from "../../../state/appStores";
import * as types from "../../../types";

/**
 * Describes client-hosted UI actions as catalog entries so they can be bound like backend actions.
 *
 * UI actions take no arguments and fire once, on a control's press or its release.
 */
export function uiActionCatalogEntries(
  actions: readonly UiActionDescriptor[],
): types.ActionCatalogEntry[] {
  return actions.map((action) => ({
    descriptor: {
      id: uiActionId(action),
      label: action.name,
      category: `UI: ${action.category ?? "General"}`,
      description: action.description,
      input: types.ActionInputKind.Trigger,
      parameters: [],
      surfaces: Object.values(types.ActionSurface),
    },
    capabilities: [],
    behaviors: [types.ControlBehavior.Press, types.ControlBehavior.Release],
  }));
}

/**
 * Returns every action this client can bind, without tracking changes.
 *
 * Includes UI actions whose panel is currently closed, since a binding outlives the panel.
 */
export function bindableActionCatalogSnapshot(): types.ActionCatalogEntry[] {
  return [
    ...actionCatalog.get(),
    ...uiActionCatalogEntries(uiActionCatalogStore.get()),
  ];
}

/**
 * Tracks every action this client can bind: the backend catalog plus every UI action seen
 * this session, including those whose panel is currently closed.
 */
export function useBindableActionCatalog(): Accessor<
  types.ActionCatalogEntry[]
> {
  const $backendCatalog = useStore(actionCatalog);
  const $uiActionCatalog = useStore(uiActionCatalogStore);
  return createMemo(() => [
    ...$backendCatalog(),
    ...uiActionCatalogEntries($uiActionCatalog()),
  ]);
}
