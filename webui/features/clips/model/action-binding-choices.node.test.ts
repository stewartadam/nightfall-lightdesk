// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Clip } from "../../../types";
import { buildClipActionBindingChoices } from "./action-binding-choices";

const uid = "10000000000040008000000000000001";

/** Makes one clip snapshot without live playback state. */
function clip(id: number, clipUid = uid): Clip {
  return {
    identifiers: { id, uid: clipUid, label: "Sequence" },
    priority: 0,
    options: { auto_release: false, deactivate_on_sequence_end: false },
  } as Clip;
}

/** Display resolution follows the saved UID across renumbering and refuses replacement numeric IDs. */
test("clip binding presentation retains UID identity across renumber and deletion", () => {
  const initial = buildClipActionBindingChoices({ [uid]: [clip(1), false] });
  const go = initial.find((choice) => choice.actionId === "clip.go")!;
  const saved = structuredClone(go.options[0].action);
  assert.deepEqual(go.resolve(saved)?.timelinePresentation, {
    type: "AdvanceSequence",
    data: uid,
  });

  const renamed = buildClipActionBindingChoices({
    [uid]: [clip(20), false],
  }).find((choice) => choice.actionId === "clip.go")!;
  assert.equal(renamed.resolve(saved)?.label, "20: Sequence");
  const replacementUid = "20000000000040008000000000000002";
  const replaced = buildClipActionBindingChoices({
    [replacementUid]: [clip(1, replacementUid), false],
  }).find((choice) => choice.actionId === "clip.go")!;
  assert.equal(replaced.resolve(saved), undefined);
  assert.equal(
    go.resolve({
      id: "clip.go",
      arguments: { target: { type: "Id", data: 1 } },
    }),
    undefined,
  );
  assert.equal(
    go.resolve({ id: "clip.stop", arguments: saved.arguments }),
    undefined,
  );
  assert.equal(
    go.resolve({ id: "clip.go", arguments: { target: null } }),
    undefined,
  );
  assert.deepEqual(saved, go.options[0].action);
});
