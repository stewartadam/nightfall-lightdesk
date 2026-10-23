// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { computed, type ReadableAtom } from "nanostores";
import type { Accessor } from "solid-js";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { clips, cues, masters, timelines } from "../../../state/appStores";
import { type ActionTargetNames, normalizeActionUid } from "./action-catalog";

/** Identifies one object that an action argument can reference. */
export interface ActionTargetOption {
  /** Normalized UID stored in action arguments. */
  uid: string;
  /** Numeric console ID used for ordering and display. */
  id: number;
  /** Display label including the console ID. */
  label: string;
}

/** Selectable targets for each object-reference parameter kind. */
export interface ActionTargetOptions {
  /** Clips in console ID order. */
  clips: () => readonly ActionTargetOption[];
  /** Masters in console ID order. */
  masters: () => readonly ActionTargetOption[];
  /** Timelines in console ID order. */
  timelines: () => readonly ActionTargetOption[];
  /** Cues in console ID order. */
  cues: () => readonly ActionTargetOption[];
}

/** Converts store records with identifiers into sorted picker options. */
function toOptions(
  records: Iterable<{
    identifiers: { uid: string; id: number; label: string };
  }>,
): ActionTargetOption[] {
  return Array.from(records, (record) => ({
    uid: normalizeActionUid(record.identifiers.uid),
    id: record.identifiers.id,
    label: `${record.identifiers.id}: ${record.identifiers.label}`,
  })).sort((left, right) => left.id - right.id);
}

/** Returns whether two option lists name the same targets in the same order. */
function sameOptions(
  left: readonly ActionTargetOption[],
  right: readonly ActionTargetOption[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (option, index) =>
        option.uid === right[index].uid &&
        option.id === right[index].id &&
        option.label === right[index].label,
    )
  );
}

/**
 * Derives one shared option list from a backend store.
 *
 * Backend stores change for many reasons that leave identities untouched (playback state,
 * cue timings), so the previous list is kept when the targets are unchanged and subscribers
 * are only notified when a target is added, removed, renumbered, or renamed.
 */
function targetOptionsStore<Value>(
  source: ReadableAtom<Value>,
  records: (value: Value) => Iterable<{
    identifiers: { uid: string; id: number; label: string };
  }>,
): ReadableAtom<ActionTargetOption[]> {
  let previous: ActionTargetOption[] = [];
  return computed(source, (value) => {
    const next = toOptions(records(value));
    if (!sameOptions(previous, next)) previous = next;
    return previous;
  });
}

/** Indexes an option list store by UID for display-name lookups. */
function labelsByUidStore(
  options: ReadableAtom<ActionTargetOption[]>,
): ReadableAtom<ReadonlyMap<string, string>> {
  return computed(
    options,
    (list) => new Map(list.map((option) => [option.uid, option.label])),
  );
}

const clipOptions = targetOptionsStore(clips, (value) =>
  Object.values(value).map(([clip]) => clip),
);
const masterOptions = targetOptionsStore(masters, Object.values);
const timelineOptions = targetOptionsStore(timelines, Object.values);
const cueOptions = targetOptionsStore(cues, Object.values);

const clipLabels = labelsByUidStore(clipOptions);
const masterLabels = labelsByUidStore(masterOptions);
const timelineLabels = labelsByUidStore(timelineOptions);
const cueLabels = labelsByUidStore(cueOptions);

/** Builds name lookups that read each label map through the given accessor. */
function namesFrom(
  read: (
    labels: ReadableAtom<ReadonlyMap<string, string>>,
  ) => Accessor<ReadonlyMap<string, string>>,
): ActionTargetNames {
  const clip = read(clipLabels);
  const master = read(masterLabels);
  const timeline = read(timelineLabels);
  const cue = read(cueLabels);
  return {
    clip: (uid) => clip().get(uid),
    master: (uid) => master().get(uid),
    timeline: (uid) => timeline().get(uid),
    cue: (uid) => cue().get(uid),
    panel: () => undefined,
  };
}

/**
 * Builds display-name lookups over the targets currently in the backend stores.
 *
 * Unlike {@link useActionTargetNames}, this reads each store once without tracking changes,
 * for describing actions outside a reactive scope such as in a command's completion.
 */
export function actionTargetNamesSnapshot(): ActionTargetNames {
  return namesFrom((labels) => {
    const snapshot = labels.get();
    return () => snapshot;
  });
}

/**
 * Tracks the objects action arguments can reference, reactive to backend stores.
 *
 * The option lists are derived once and shared by every consumer, so mounting many
 * consumers costs one subscription each instead of a copy of every clip and cue.
 */
export function useActionTargetOptions(): ActionTargetOptions {
  return {
    clips: useShallowStore(clipOptions),
    masters: useShallowStore(masterOptions),
    timelines: useShallowStore(timelineOptions),
    cues: useShallowStore(cueOptions),
  };
}

/**
 * Builds reactive display-name lookups over the targets in the backend stores.
 *
 * Every mappable control uses these, so the lookups share module-level label maps rather
 * than mirroring the clip and cue stores per component.
 */
export function useActionTargetNames(): ActionTargetNames {
  return namesFrom(useShallowStore);
}
