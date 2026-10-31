// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { setStoreAction } from "../lib/nanostore-action";
import type * as types from "../types";
import { fixtureDrafts } from "./appStores";

/**
 * Drafts closed since the last full listing. A command result or broadcast
 * sent before a discard can arrive after it, and must not bring the draft back.
 */
const closedDraftIds = new Set<types.DraftId>();

/**
 * Inserts or replaces one draft view in id order. A view arrives both as a
 * command's result and as the broadcast sent to every client, in either
 * order, so a view older than the one held, or of a closed draft, is ignored.
 */
export function upsertFixtureDraft(
  drafts: readonly types.FixtureDraftView[],
  view: types.FixtureDraftView,
  closed: ReadonlySet<types.DraftId> = closedDraftIds,
): types.FixtureDraftView[] {
  if (closed.has(view.draft_id)) return [...drafts];
  const held = drafts.find((draft) => draft.draft_id === view.draft_id);
  if (held && held.version > view.version) return [...drafts];
  const others = drafts.filter((draft) => draft.draft_id !== view.draft_id);
  return [...others, view].sort((a, b) => a.draft_id - b.draft_id);
}

/** Applies a broadcast or returned draft view to the shared draft store. */
export function applyFixtureDraftUpdated(
  view: types.FixtureDraftView,
  actionName = "Receive FixtureDraftUpdated",
): void {
  setStoreAction(
    fixtureDrafts,
    actionName,
    upsertFixtureDraft(fixtureDrafts.get(), view),
  );
}

/** Removes a draft the backend closed after a discard. */
export function applyFixtureDraftClosed(draftId: types.DraftId): void {
  closedDraftIds.add(draftId);
  setStoreAction(
    fixtureDrafts,
    "Receive FixtureDraftClosed",
    fixtureDrafts.get().filter((draft) => draft.draft_id !== draftId),
  );
}

/**
 * Replaces the draft store with a full listing, as returned when a window
 * connects. The listing is authoritative, so it also forgets closed drafts:
 * a restarted backend numbers its drafts from the start again.
 */
export function replaceFixtureDrafts(
  views: readonly types.FixtureDraftView[],
): void {
  closedDraftIds.clear();
  setStoreAction(
    fixtureDrafts,
    "Receive ListDrafts",
    [...views].sort((a, b) => a.draft_id - b.draft_id),
  );
}
