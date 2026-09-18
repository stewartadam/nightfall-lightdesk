// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { activeLayoutId } from "../state/layout-switcher";
import type * as types from "../types";
import {
  createSerializedLayout,
  type SerializedLayout,
} from "./dockview-layout";

/** Recursively sorts object keys so JSON comparison ignores insertion order. */
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeJsonValue(child)]),
  );
}

/** Converts a showfile-backed active panel layout into the shared restore shape. */
export function activeLayoutToSerializedLayout(
  layout: types.ActivePanelLayout,
): SerializedLayout {
  return {
    version: layout.version,
    layout: layout.layout,
    panels: layout.panels,
  };
}

/** Captures the current Dockview layout for storage in a showfile save snapshot. */
export function createActivePanelLayout(
  api: DockviewApi,
): types.ActivePanelLayout {
  const layout = createSerializedLayout(api);
  return {
    ...layout,
    layoutId: activeLayoutId.get() ?? undefined,
    panels: layout.panels.map((panel) => ({
      ...panel,
      params: panel.params ?? {},
    })),
    updatedAt: Date.now(),
  };
}

/** Returns a stable comparison key for an active panel layout snapshot. */
export function activeLayoutKey(
  layout: types.ActivePanelLayout | null | undefined,
): string | null {
  if (!layout) {
    return null;
  }

  return JSON.stringify(
    canonicalizeJsonValue({
      layoutId: layout.layoutId,
      version: layout.version,
      layout: layout.layout,
      panels: layout.panels,
    }),
  );
}
