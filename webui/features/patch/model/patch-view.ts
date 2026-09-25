// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";

export type PatchTab = "fixtures" | "bindings";

const PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY = "nightfall-patch-panel:active-tab";

/**
 * Returns whether a stored value is a supported patch panel tab.
 */
export function isPatchTab(value: string): value is PatchTab {
  return value === "fixtures" || value === "bindings";
}

/** Remembers whether Patch shows its Fixtures or DMX I/O view across sessions. */
export const patchPanelActiveTab = bestEffortPersistentAtom<PatchTab>(
  PATCH_PANEL_ACTIVE_TAB_STORAGE_KEY,
  "fixtures",
  {
    decode: (value) => (isPatchTab(value) ? value : "fixtures"),
    encode: (value) => value,
  },
);
