// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types/index";
import {
  activeCueUidFromPreviewInstance,
  findCuePreviewInstance,
  findSequencePreviewInstance,
} from "./preview-instance";

/** Builds a instance record with overridable source identity and release state. */
function instance(
  instanceId: string,
  objectRef: types.ObjectRef | undefined,
  isPreview = true,
  isReleasing = false,
): types.InstanceInfo {
  return {
    instance_id: instanceId,
    kind: types.InstanceKind.Cue,
    display_kind: types.InstanceDisplayKind.Cue,
    name: undefined,
    tags: [],
    object_ref: objectRef,
    is_preview: isPreview,
    is_releasing: isReleasing,
    is_paused: false,
    owner_uids: [],
    bound_clip_id: undefined,
    intensity_scale: 1,
    rate: 1,
    rate_master_scale: 1,
    effective_rate: 1,
    status: { position: { type: "None" } },
  };
}

/** Builds an object reference for a source object UID. */
function objectRef(objectType: types.ObjectType, uid: string): types.ObjectRef {
  return {
    type: "ByUid",
    data: {
      object_type: objectType,
      uid,
    },
  };
}

/** Builds a sequence instance status carrying the active cue UID. */
function sequenceStatus(activeCueUid: string): types.InstanceStatus {
  return {
    position: {
      type: "Sequence",
      data: {
        sequence_uid: "01234567-89ab-4def-8123-456789abcdef",
        current_position: 1,
        cue_count: 1,
        current_cue_uid: activeCueUid,
        current_part_count: 1,
        retained_cues: [],
      },
    },
  };
}

test("findCuePreviewInstance ignores releasing cue previews", () => {
  const instances = {
    old: instance("old", objectRef(types.ObjectType.Cue, "cue-a"), true, true),
    active: instance("active", objectRef(types.ObjectType.Cue, "cue-a")),
  };

  assert.equal(
    findCuePreviewInstance(instances, "cue-a")?.instance_id,
    "active",
  );
});

test("findCuePreviewInstance matches compact store UUIDs to hyphenated object refs", () => {
  const instances = {
    active: instance(
      "active",
      objectRef(types.ObjectType.Cue, "69e0f75b-d2a9-4b07-b07d-7c83a96345ee"),
    ),
  };

  assert.equal(
    findCuePreviewInstance(instances, "69e0f75bd2a94b07b07d7c83a96345ee")
      ?.instance_id,
    "active",
  );
});

test("findSequencePreviewInstance resolves matching sequence preview object ref", () => {
  const instances = {
    cue: instance("cue", objectRef(types.ObjectType.Cue, "cue-a")),
    sequence: {
      ...instance(
        "sequence",
        objectRef(
          types.ObjectType.Sequence,
          "01234567-89ab-4def-8123-456789abcdef",
        ),
      ),
      status: sequenceStatus("69e0f75b-d2a9-4b07-b07d-7c83a96345ee"),
    },
  };

  const match = findSequencePreviewInstance(
    instances,
    "0123456789ab4def8123456789abcdef",
  );
  assert.equal(match?.instance_id, "sequence");
  assert.equal(
    activeCueUidFromPreviewInstance(match),
    "69e0f75bd2a94b07b07d7c83a96345ee",
  );
});
