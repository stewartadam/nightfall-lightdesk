// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createContext, useContext } from "solid-js";
import type * as types from "../../../types";
import type { DraftChange } from "../services/draft-queue";

/** What the editing sections share: the draft on screen and the way to change it. */
export interface DraftEditing {
  /** The draft's current view, updated by every window's edits. */
  draft: () => types.FixtureDraftView;
  /** Standard attributes offered when picking a channel's attribute. */
  attributeOptions: () => readonly types.DraftAttributeOption[];
  /**
   * Applies one edit after any edit still in flight from this window, and
   * resolves whether it applied. Pass a function to build the edit from the
   * draft as it stands when sent, so edits that resend whole lists or field
   * sets keep the changes queued before them.
   * A refused edit is reported above the page.
   */
  edit: (change: DraftChange) => Promise<boolean>;
}

/** Shares the draft being edited with the sections of the editing page. */
export const DraftEditingContext = createContext<DraftEditing>();

/** Returns the draft being edited; only valid inside the editing page. */
export function useDraftEditing(): DraftEditing {
  const editing = useContext(DraftEditingContext);
  if (!editing) {
    throw new Error("useDraftEditing must be used inside the draft editor");
  }
  return editing;
}
