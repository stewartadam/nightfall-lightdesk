// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom, computed } from "nanostores";
import {
  type SerializedLayout,
  serializedLayoutGeometryKey,
  serializedLayoutKey,
} from "../lib/dockview-layout";
import { layoutStorageStore } from "../lib/layoutStorage";

/** The named layout owning the mounted workspace. */
export const activeLayoutId = atom<string | null>(null);
/** Reports queued management edits so initial workspace adoption can wait for persistence. */
export const layoutEditPending = atom(false);
/** Layouts with pending edits, preventing conflicting actions on just those entries. */
export const busyLayoutIds = atom<string[]>([]);
const sessionInvalidationListeners = new Set<(layoutId?: string) => void>();
const sessionLayouts = new Map<string, SerializedLayout>();
const sessionRevision = atom(0);
const resizeEdits = new Map<
  string,
  { baseline: string; current: string; revision: number }
>();
let resizeRevision = 0;
const restoredBaselines = new Map<
  string,
  { saved: string; restored: string }
>();
/** Layouts whose working arrangement differs from their saved snapshot. */
export const modifiedLayoutIds = computed(
  [sessionRevision, layoutStorageStore],
  (_, storage) =>
    storage.layouts.flatMap((saved) => {
      const session = sessionLayouts.get(saved.id);
      if (!session) return [];
      const savedKey = serializedLayoutKey(saved);
      const baseline = restoredBaselines.get(saved.id);
      const key = serializedLayoutKey(session, false);
      const sameArrangement =
        key === serializedLayoutKey(saved, false) ||
        (baseline?.saved === savedKey && key === baseline.restored);
      const resize = resizeEdits.get(saved.id);
      return sameArrangement && (!resize || resize.baseline === resize.current)
        ? []
        : [saved.id];
    }),
);

/** Subscribes workspace owners to deletion and showfile invalidation. */
export function onLayoutSessionInvalidated(
  listener: (layoutId?: string) => void,
): () => void {
  sessionInvalidationListeners.add(listener);
  return () => {
    sessionInvalidationListeners.delete(listener);
  };
}

/** Discards working arrangements only for deleted layouts, preserving hidden ones. */
export function reconcileLayoutSessions(ids: string[]): void {
  for (const id of sessionLayouts.keys()) {
    if (!ids.includes(id)) forgetLayoutSession(id);
  }
  const active = activeLayoutId.get();
  if (active && !ids.includes(active)) activeLayoutId.set(null);
}

/** Clears local working arrangements when the showfile context changes. */
export function clearLayoutSessions(): void {
  sessionLayouts.clear();
  restoredBaselines.clear();
  resizeEdits.clear();
  sessionRevision.set(sessionRevision.get() + 1);
  for (const listener of sessionInvalidationListeners) listener();
  activeLayoutId.set(null);
}

/** Captures a working arrangement and clears explicit resize history when restoring a saved snapshot. */
export function rememberLayoutSession(
  id: string,
  layout: SerializedLayout,
  restoredFrom?: SerializedLayout,
): void {
  if (restoredFrom) {
    resizeEdits.delete(id);
    restoredBaselines.set(id, {
      saved: serializedLayoutKey(restoredFrom),
      restored: serializedLayoutKey(layout, false),
    });
  }
  sessionLayouts.set(id, layout);
  sessionRevision.set(sessionRevision.get() + 1);
}

/** Returns the working arrangement of a layout visited during this session. */
export function getLayoutSession(id: string): SerializedLayout | undefined {
  return sessionLayouts.get(id);
}

/** Discards a deleted layout's working arrangement and retained workspace. */
export function forgetLayoutSession(id: string): void {
  sessionLayouts.delete(id);
  restoredBaselines.delete(id);
  resizeEdits.delete(id);
  sessionRevision.set(sessionRevision.get() + 1);
  for (const listener of sessionInvalidationListeners) listener(id);
}

/** Records geometry changed by an operator gesture, leaving automatic sizing out of dirty state. */
export function rememberLayoutResize(
  id: string,
  before: SerializedLayout,
  after: SerializedLayout,
): void {
  const initial = serializedLayoutGeometryKey(before);
  const current = serializedLayoutGeometryKey(after);
  if (initial === current) return;
  resizeEdits.set(id, {
    baseline: resizeEdits.get(id)?.baseline ?? initial,
    current,
    revision: ++resizeRevision,
  });
  rememberLayoutSession(id, after);
}

/** Captures the latest explicit resize so a delayed save cannot clear a newer edit. */
export function getLayoutResizeRevision(id: string): number | undefined {
  return resizeEdits.get(id)?.revision;
}

/** Advances the resize baseline to a successful save while retaining any later gesture. */
export function acknowledgeLayoutResize(
  id: string,
  revision: number | undefined,
  snapshot: SerializedLayout,
): void {
  const current = resizeEdits.get(id);
  if (!current) return;
  if (current.revision === revision) resizeEdits.delete(id);
  else
    resizeEdits.set(id, {
      ...current,
      baseline: serializedLayoutGeometryKey(snapshot),
    });
  sessionRevision.set(sessionRevision.get() + 1);
}
