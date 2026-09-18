// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Replaces known selectable UIDs in a mixed visualizer selection.
 */
export function replaceKnownUidsInSelection(
  currentSelection: readonly string[],
  allSelectableUids: readonly string[],
  selectedUids: readonly string[],
): string[] {
  const selectableUidSet = new Set(allSelectableUids);
  const nextSelection = currentSelection.filter(
    (uid) => !selectableUidSet.has(uid),
  );

  for (const uid of selectedUids) {
    if (!selectableUidSet.has(uid) || nextSelection.includes(uid)) continue;
    nextSelection.push(uid);
  }

  return nextSelection;
}

/**
 * Replaces fixture UIDs in a mixed visualizer selection while preserving non-fixture UIDs.
 */
export function replaceFixtureUidsInSelection(
  currentSelection: readonly string[],
  allFixtureUids: readonly string[],
  selectedFixtureUids: readonly string[],
): string[] {
  return replaceKnownUidsInSelection(
    currentSelection,
    allFixtureUids,
    selectedFixtureUids,
  );
}

/**
 * Applies visualizer selection modifiers to one selectable UID family.
 */
export function applyVisualizerSelectionModifiers(
  currentSelection: readonly string[],
  allSelectableUids: readonly string[],
  selectedUids: readonly string[],
  modifiers: { shiftKey: boolean; ctrlOrMetaKey: boolean },
): string[] {
  const selectableUidSet = new Set(allSelectableUids);
  const selectedUidSet = new Set(
    selectedUids.filter((uid) => selectableUidSet.has(uid)),
  );
  const currentSelectableSelection = currentSelection.filter((uid) =>
    selectableUidSet.has(uid),
  );

  if (modifiers.ctrlOrMetaKey) {
    if (selectedUidSet.size === 0) return currentSelectableSelection;
    return currentSelectableSelection.filter((uid) => !selectedUidSet.has(uid));
  }

  if (modifiers.shiftKey) {
    const nextSelection = [...currentSelectableSelection];
    for (const uid of selectedUidSet) {
      if (!nextSelection.includes(uid)) {
        nextSelection.push(uid);
      }
    }
    return nextSelection;
  }

  return [...selectedUidSet];
}

/**
 * Combines fixture and scene-object selection lists without duplicate UIDs.
 */
export function combineVisualizerSelectionUids(
  fixtureSelection: readonly string[],
  sceneObjectSelection: readonly string[],
): string[] {
  const nextSelection: string[] = [];
  for (const uid of [...fixtureSelection, ...sceneObjectSelection]) {
    if (!nextSelection.includes(uid)) {
      nextSelection.push(uid);
    }
  }
  return nextSelection;
}

/**
 * Returns true when both UID lists contain the same values in the same order.
 */
export function orderedUidListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((uid, index) => uid === right[index])
  );
}
