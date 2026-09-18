// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/binding-utils";
import * as types from "../../../types";

/** Normalizes UUID strings from Rust and web UI stores for comparison. */
function normalizePreviewUid(uid: unknown): string {
  return normalizeFixtureUid(uid).toLowerCase();
}

/** Returns the source object UID when a instance references the requested object type. */
function instanceObjectUid(
  instance: types.InstanceInfo,
  objectType: types.ObjectType,
): string | undefined {
  const objectRef = instance.object_ref;
  if (
    objectRef?.type !== "ByUid" ||
    objectRef.data.object_type !== objectType
  ) {
    return undefined;
  }
  return normalizePreviewUid(objectRef.data.uid);
}

/** Returns whether a instance is an active, non-releasing editor preview. */
function isActivePreviewInstance(instance: types.InstanceInfo): boolean {
  return instance.is_preview && !instance.is_releasing;
}

/** Finds the active cue-preview instance for a cue UID. */
export function findCuePreviewInstance(
  instances: Record<string, types.InstanceInfo>,
  cueUid: string,
): types.InstanceInfo | undefined {
  return Object.values(instances).find(
    (instance) =>
      isActivePreviewInstance(instance) &&
      instanceObjectUid(instance, types.ObjectType.Cue) ===
        normalizePreviewUid(cueUid),
  );
}

/** Finds the active sequence-preview instance for a sequence UID. */
export function findSequencePreviewInstance(
  instances: Record<string, types.InstanceInfo>,
  sequenceUid: string,
): types.InstanceInfo | undefined {
  return Object.values(instances).find(
    (instance) =>
      isActivePreviewInstance(instance) &&
      instanceObjectUid(instance, types.ObjectType.Sequence) ===
        normalizePreviewUid(sequenceUid),
  );
}

/** Returns the active cue UID carried by a sequence-preview instance. */
export function activeCueUidFromPreviewInstance(
  instance: types.InstanceInfo | undefined,
): string | undefined {
  if (!instance) return undefined;
  const position = instance.status.position;
  if (position.type !== "Sequence") return undefined;
  const cueUid = position.data.current_cue_uid;
  return cueUid ? normalizePreviewUid(cueUid) : undefined;
}
