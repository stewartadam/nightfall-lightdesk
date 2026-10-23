// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  dockviewHostStyle,
  EDGE_DROP_TARGET_SIZE,
  getEdgeDropPositionFromPoint,
  HIDDEN_EDGE_GROUP_PADDING,
} from "./edge-drop-geometry";

/** Element stand-in whose bounds span (left, top) to (right, bottom). */
function elementWithBounds(
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    getBoundingClientRect: () => ({ left, top, right, bottom }) as DOMRect,
  };
}

const workspace = elementWithBounds(100, 50, 900, 650);
const allEdges = ["left", "bottom", "right"] as const;

/** Pointers inside each band resolve to that band when it is an active target. */
test("resolves points inside each active edge band", () => {
  assert.equal(
    getEdgeDropPositionFromPoint(
      workspace,
      100 + EDGE_DROP_TARGET_SIZE,
      300,
      allEdges,
    ),
    "left",
  );
  assert.equal(
    getEdgeDropPositionFromPoint(
      workspace,
      900 - EDGE_DROP_TARGET_SIZE,
      300,
      allEdges,
    ),
    "right",
  );
  assert.equal(
    getEdgeDropPositionFromPoint(
      workspace,
      500,
      650 - EDGE_DROP_TARGET_SIZE,
      allEdges,
    ),
    "bottom",
  );
});

/** Points outside the workspace or in its interior never resolve to a band. */
test("ignores points outside the bands", () => {
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 500, 300, allEdges),
    undefined,
  );
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 99, 300, allEdges),
    undefined,
  );
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 500, 651, allEdges),
    undefined,
  );
});

/** Corners prefer the side bands, and inactive bands fall through to the next one. */
test("prioritizes side bands and skips inactive targets", () => {
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 110, 640, allEdges),
    "left",
  );
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 110, 640, ["bottom", "right"]),
    "bottom",
  );
  assert.equal(
    getEdgeDropPositionFromPoint(workspace, 110, 300, ["right"]),
    undefined,
  );
});

/** The armed band reserves the full drop size, while hidden side edges keep resting padding. */
test("insets the host for armed and hidden edges", () => {
  assert.deepEqual(dockviewHostStyle(undefined, []), {
    bottom: "0px",
    left: "0px",
    right: "0px",
  });
  assert.deepEqual(dockviewHostStyle("left", ["left", "right", "bottom"]), {
    bottom: "0px",
    left: `${EDGE_DROP_TARGET_SIZE}px`,
    right: `${HIDDEN_EDGE_GROUP_PADDING}px`,
  });
  assert.deepEqual(dockviewHostStyle("bottom", []), {
    bottom: `${EDGE_DROP_TARGET_SIZE}px`,
    left: "0px",
    right: "0px",
  });
});
