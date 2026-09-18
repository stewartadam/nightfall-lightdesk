// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

export interface GroupSelectionModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface NewGroupPayload {
  id: number;
  label: string;
}

/** Sorts stored groups by numeric showfile identifier without mutating the map. */
export function sortGroupsById(
  groupMap: Readonly<Record<string, types.Group>>,
): types.Group[] {
  return Object.values(groupMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns the searchable scalar projection for one group. */
export function groupSearchValues(
  group: types.Group,
): readonly (string | number)[] {
  return [group.identifiers.id, group.identifiers.label, group.description];
}

/** Finds the first positive group identifier not used by the current rows. */
export function nextAvailableGroupId(groups: readonly types.Group[]): number {
  const existingIds = new Set(groups.map((group) => group.identifiers.id));
  let id = 1;
  while (existingIds.has(id)) id++;
  return id;
}

/** Creates a new empty group with a caller-supplied stable UID. */
export function createEmptyGroup(
  payload: NewGroupPayload,
  uid: string,
): types.Group {
  return {
    identifiers: {
      id: payload.id,
      uid,
      label: payload.label,
    },
    selection: {
      source: { type: "Resolved", data: [] },
      clauses: [],
    },
    description: "",
  };
}

/** Builds programmer selection semantics from group ID and pointer modifiers. */
export function buildGroupProgrammerCommand(
  groupId: number,
  modifiers: GroupSelectionModifiers,
): types.ProgrammerCommand {
  const selection: types.SelectionExpr = {
    type: "Group",
    data: { type: "ById", data: groupId },
  };

  if (modifiers.shiftKey) {
    return { type: "AddProgrammerSelection", data: selection };
  }
  if (modifiers.ctrlKey || modifiers.metaKey) {
    return { type: "RemoveProgrammerSelection", data: selection };
  }
  return { type: "SetProgrammerSelection", data: selection };
}
