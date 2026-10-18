// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DialogStackEntry,
  type DismissableLayerEntry,
  dismissableEscapeAction,
  frontmostDialog,
  hasOpenDialog,
  isInsideLayerAbove,
  registerDialog,
  registerDismissableLayer,
} from "./dialog-stack";

/** Builds a dialog entry whose root element contains only the given nodes. */
function dialogEntry(members: readonly object[] = []): DialogStackEntry {
  return {
    element: () =>
      ({
        contains: (node: Node) => members.includes(node),
      }) as unknown as HTMLElement,
    escapeAction: () => () => {},
    enterAction: () => undefined,
    blocksBackgroundKeys: () => false,
  };
}

/** Builds a transient layer that records its Escape dismissals and owns the given nodes. */
function layerEntry(
  log: string[],
  name: string,
  options: { members?: readonly object[]; escape?: boolean } = {},
): DismissableLayerEntry {
  return {
    contains: (node) => (options.members ?? []).includes(node),
    escapeAction: () =>
      options.escape === false ? undefined : () => log.push(name),
  };
}

/** Verifies a popover opened inside a dialog takes Escape first without counting as a dialog. */
test("a layer above a dialog takes Escape and is not an open dialog", () => {
  const log: string[] = [];
  const dialog = dialogEntry();
  const removeDialog = registerDialog(dialog);
  const removeLayer = registerDismissableLayer(layerEntry(log, "dropdown"));
  try {
    assert.equal(frontmostDialog(), dialog);
    dismissableEscapeAction()?.();
    assert.deepEqual(log, ["dropdown"]);

    removeLayer();
    assert.equal(dismissableEscapeAction(), undefined);
    assert.equal(hasOpenDialog(), true);
  } finally {
    removeLayer();
    removeDialog();
  }
});

/** Verifies a layer alone never makes hasOpenDialog true, so layout switching from menu items still works. */
test("a layer alone does not count as an open dialog", () => {
  const log: string[] = [];
  const removeLayer = registerDismissableLayer(layerEntry(log, "menu"));
  try {
    assert.equal(hasOpenDialog(), false);
    assert.equal(frontmostDialog(), undefined);
    dismissableEscapeAction()?.();
    assert.deepEqual(log, ["menu"]);
  } finally {
    removeLayer();
  }
});

/** Verifies a dialog opened over a layer owns Escape, and that the topmost of nested layers goes first. */
test("Escape follows stacking order across layers and dialogs", () => {
  const log: string[] = [];
  const removeOuter = registerDismissableLayer(layerEntry(log, "outer"));
  const removeDialog = registerDialog(dialogEntry());
  try {
    assert.equal(dismissableEscapeAction(), undefined);
  } finally {
    removeDialog();
  }
  const removeInner = registerDismissableLayer(layerEntry(log, "inner"));
  try {
    dismissableEscapeAction()?.();
    removeInner();
    dismissableEscapeAction()?.();
    assert.deepEqual(log, ["inner", "outer"]);
  } finally {
    removeInner();
    removeOuter();
  }
});

/** Verifies a layer with Escape switched off passes the key to the layer beneath it. */
test("a layer without Escape passes it down", () => {
  const log: string[] = [];
  const removeLower = registerDismissableLayer(layerEntry(log, "lower"));
  const removeUpper = registerDismissableLayer(
    layerEntry(log, "upper", { escape: false }),
  );
  try {
    dismissableEscapeAction()?.();
    assert.deepEqual(log, ["lower"]);
  } finally {
    removeUpper();
    removeLower();
  }
});

/** Verifies presses inside a nested layer or a dialog stacked above do not count as outside the lower layer. */
test("presses inside layers stacked above are not outside presses", () => {
  const nestedNode = {};
  const dialogNode = {};
  const strayNode = {};
  const lower = layerEntry([], "lower");
  const removeLower = registerDismissableLayer(lower);
  const nested = layerEntry([], "nested", { members: [nestedNode] });
  const removeNested = registerDismissableLayer(nested);
  const removeDialog = registerDialog(dialogEntry([dialogNode]));
  try {
    assert.equal(isInsideLayerAbove(lower, nestedNode as Node), true);
    assert.equal(isInsideLayerAbove(lower, dialogNode as Node), true);
    assert.equal(isInsideLayerAbove(lower, strayNode as Node), false);
    assert.equal(isInsideLayerAbove(nested, nestedNode as Node), false);
  } finally {
    removeDialog();
    removeNested();
    removeLower();
  }
});
