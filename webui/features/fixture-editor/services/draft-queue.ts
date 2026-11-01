// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/** An edit, or a way to build one from the draft as it stands when the edit is sent. */
export type DraftChange =
  | types.DraftEdit
  | ((draft: types.FixtureDraftView) => types.DraftEdit);

/** What the queue needs from the rest of the editor. */
export interface DraftQueueDeps {
  /** Returns the latest view of a draft, or none once it closed. */
  draft: (draftId: types.DraftId) => types.FixtureDraftView | undefined;
  /** Sends one edit against `base.version` and returns the new view. */
  send: (
    base: types.FixtureDraftView,
    edit: types.DraftEdit,
  ) => Promise<types.FixtureDraftView>;
}

/** Sends one window's draft commands in order; see `createDraftQueue`. */
export interface DraftQueue {
  /**
   * Queues an edit made while `seen` was on screen. Resolves to the new
   * view, or none when the draft closed first; rejects when it is refused.
   */
  edit(
    seen: types.FixtureDraftView,
    change: DraftChange,
  ): Promise<types.FixtureDraftView | undefined>;
  /**
   * Queues another command that changes a draft, such as undo or save.
   * Resolves to none, without running it, when the draft closed first.
   */
  command(
    draftId: types.DraftId,
    work: (draftId: types.DraftId) => Promise<types.FixtureDraftView>,
  ): Promise<types.FixtureDraftView | undefined>;
}

/**
 * Sends a window's draft commands one at a time, so a quick run of edits is
 * not refused as stale just because the previous one was still in flight.
 *
 * Each edit was made against the view on screen when the user made it. The
 * queue counts the versions this window's own commands produced since then;
 * when the draft moved only by those, the edit goes out against the latest
 * version, built from the latest view. When another window changed the
 * draft in between, it goes out against the version the user saw, and the
 * backend refuses it as stale instead of applying it to a channel or
 * function that may have moved.
 */
export function createDraftQueue(deps: DraftQueueDeps): DraftQueue {
  let tail: Promise<unknown> = Promise.resolve();
  /** Versions each draft advanced by through this window's own commands. */
  const ownProgress = new Map<types.DraftId, number>();

  /** Runs `work` after every command queued before it, whatever their outcome. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };

  /** Counts the versions one of this window's commands moved a draft by. */
  const record = (
    draftId: types.DraftId,
    before: number,
    after: types.FixtureDraftView,
  ) => {
    ownProgress.set(
      draftId,
      (ownProgress.get(draftId) ?? 0) + after.version - before,
    );
  };

  return {
    edit(seen, change) {
      const draftId = seen.draft_id;
      const progressAtEdit = ownProgress.get(draftId) ?? 0;
      return enqueue(async () => {
        const latest = deps.draft(draftId);
        if (!latest) return undefined;
        const ownChangesSince =
          (ownProgress.get(draftId) ?? 0) - progressAtEdit;
        const unchangedElsewhere =
          latest.version === seen.version + ownChangesSince;
        const base = unchangedElsewhere
          ? latest
          : { ...latest, version: seen.version };
        const edit = typeof change === "function" ? change(latest) : change;
        const view = await deps.send(base, edit);
        record(draftId, latest.version, view);
        return view;
      });
    },

    command(draftId, work) {
      return enqueue(async () => {
        const before = deps.draft(draftId)?.version;
        if (before === undefined) return undefined;
        const view = await work(draftId);
        record(draftId, before, view);
        return view;
      });
    },
  };
}
