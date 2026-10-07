// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createCameraHandoff } from "./camera-handoff";

/**
 * A quality remount consumes the outgoing pose once; a later remount (such as an error-boundary
 * reset) must not reapply that stale pose over the camera the user has moved since.
 */
test("camera hand-off is consumed by the first remount only", () => {
  const handoff = createCameraHandoff();
  const pose = {
    position: { x: 1, y: 2, z: 3 },
    target: { x: 0, y: 1, z: 0 },
  };
  assert.equal(handoff.take(), undefined);
  handoff.offer(pose);
  assert.equal(handoff.take(), pose);
  assert.equal(handoff.take(), undefined);
});
