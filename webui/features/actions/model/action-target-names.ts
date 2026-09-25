// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
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
  clips: () => ActionTargetOption[];
  /** Masters in console ID order. */
  masters: () => ActionTargetOption[];
  /** Timelines in console ID order. */
  timelines: () => ActionTargetOption[];
  /** Cues in console ID order. */
  cues: () => ActionTargetOption[];
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

/**
 * Builds display-name lookups over the targets currently in the backend stores.
 *
 * Unlike {@link useActionTargetNames}, this reads each store once without tracking changes,
 * for describing actions outside a reactive scope such as in a command's completion.
 */
export function actionTargetNamesSnapshot(): ActionTargetNames {
  /** Indexes one option list by UID. */
  const lookup = (options: ActionTargetOption[]) => {
    const byUid = new Map(options.map((option) => [option.uid, option.label]));
    return (uid: string) => byUid.get(uid);
  };
  return {
    clip: lookup(toOptions(Object.values(clips.get()).map(([clip]) => clip))),
    master: lookup(toOptions(Object.values(masters.get()))),
    timeline: lookup(toOptions(Object.values(timelines.get()))),
    cue: lookup(toOptions(Object.values(cues.get()))),
    panel: () => undefined,
  };
}

/** Tracks the objects action arguments can reference, reactive to backend stores. */
export function useActionTargetOptions(): ActionTargetOptions {
  const $clips = useStore(clips);
  const $masters = useStore(masters);
  const $timelines = useStore(timelines);
  const $cues = useStore(cues);
  return {
    clips: createMemo(() =>
      toOptions(Object.values($clips()).map(([clip]) => clip)),
    ),
    masters: createMemo(() => toOptions(Object.values($masters()))),
    timelines: createMemo(() => toOptions(Object.values($timelines()))),
    cues: createMemo(() => toOptions(Object.values($cues()))),
  };
}

/** Builds display-name lookups over the current target options. */
export function useActionTargetNames(
  options: ActionTargetOptions = useActionTargetOptions(),
): ActionTargetNames {
  /** Creates a UID lookup over one reactive option list. */
  const lookup = (list: () => ActionTargetOption[]) => {
    const byUid = createMemo(
      () => new Map(list().map((option) => [option.uid, option.label])),
    );
    return (uid: string) => byUid().get(uid);
  };
  return {
    clip: lookup(options.clips),
    master: lookup(options.masters),
    timeline: lookup(options.timelines),
    cue: lookup(options.cues),
    panel: () => undefined,
  };
}
