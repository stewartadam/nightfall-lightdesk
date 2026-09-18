// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  ARFixtureRow,
  ElementRowExtension,
  ExpandableRowExtension,
} from "../../../lib/datagrid";
import { parseValueSourceEditResult } from "../../../lib/value-source";
import type * as types from "../../../types";
export type ProgrammerParentRow = ARFixtureRow & ExpandableRowExtension;
export type ProgrammerElementRow = ARFixtureRow & ElementRowExtension;
export type ProgrammerDisplayRow = ProgrammerParentRow | ProgrammerElementRow;

export interface ProgrammerValueEditTarget {
  row: ProgrammerDisplayRow;
  columnId: string;
  input: string;
}

export interface CueTargetOption {
  key: string;
  sequenceId: number;
  cueId: number;
  cueLabel: string;
  sequenceLabel: string;
}

export interface GroupTargetOption {
  key: string;
  groupId: number;
  label: string;
}

export const clampIdInput = (value: number): number => {
  const normalized = Math.floor(Number.isFinite(value) ? value : 1);
  return Math.max(1, normalized);
};

/** Returns the parsed attribute, value, and fixture reference for one valid edit. */
function programmerValueEditData(target: ProgrammerValueEditTarget):
  | {
      attribute: string;
      source: types.ValueSource;
      fixtureRef: types.FixtureRef;
    }
  | undefined {
  const attribute = target.columnId.match(/^(.+)_Value$/)?.[1];
  if (!attribute || !target.row.applicableAttributes.has(attribute)) {
    return undefined;
  }

  const parsed = parseValueSourceEditResult(target.input);
  if (parsed.type !== "Valid") return undefined;

  const fixtureRef: types.FixtureRef =
    target.row.type === "element"
      ? {
          fixture_uid: target.row.fixtureUid,
          index: target.row.elementIndex,
        }
      : { fixture_uid: target.row.uid };
  return { attribute, source: parsed.source, fixtureRef };
}

/** Builds the smallest compatible set of programmer instructions for grid edits. */
export function buildProgrammerValueEditCommands(
  targets: readonly ProgrammerValueEditTarget[],
): types.ProgrammerCommand[] {
  const groups = new Map<
    string,
    {
      attribute: string;
      source: types.ValueSource;
      fixtureRefs: Map<string, types.FixtureRef>;
    }
  >();

  for (const target of targets) {
    const edit = programmerValueEditData(target);
    if (!edit) continue;
    const groupKey = `${edit.attribute}:${JSON.stringify(edit.source)}`;
    const group = groups.get(groupKey) ?? {
      attribute: edit.attribute,
      source: edit.source,
      fixtureRefs: new Map<string, types.FixtureRef>(),
    };
    const fixtureKey = `${edit.fixtureRef.fixture_uid}:${edit.fixtureRef.index ?? ""}`;
    group.fixtureRefs.set(fixtureKey, edit.fixtureRef);
    groups.set(groupKey, group);
  }

  return [...groups.values()].map((group) => ({
    type: "AddProgrammerInstruction",
    data: {
      selection: {
        source: {
          type: "Resolved",
          data: [...group.fixtureRefs.values()],
        },
        clauses: [],
      },
      instruction: {
        values: { [group.attribute]: group.source },
        transitions_by_attribute: {},
        transitions: {},
      },
    },
  }));
}

/** Builds a programmer instruction that applies a valid edited value to one row. */
export function buildProgrammerValueEditCommand(
  row: ProgrammerDisplayRow,
  columnId: string,
  input: string,
): types.ProgrammerCommand | undefined {
  return buildProgrammerValueEditCommands([{ row, columnId, input }])[0];
}
