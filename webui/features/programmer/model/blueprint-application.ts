// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

export interface BlueprintApplicationScope {
  targets: readonly types.BlueprintSelector[];
  selection?: types.SpatialSelection;
}

/** Builds the shared programmer command for referenced or absolute Blueprint application. */
export function blueprintApplicationCommand(
  blueprintId: number,
  targets: readonly types.BlueprintSelector[],
  resolution: types.BlueprintResolution,
  selection?: types.SpatialSelection,
): types.ProgrammerCommand | undefined {
  const operations: types.ProgrammerAttributeOperation[] = targets.map(
    (target) => ({
      target,
      source: {
        type: "Blueprint",
        data: {
          address: { type: "Id", data: blueprintId },
          resolution,
        },
      },
    }),
  );
  if (operations.length === 0) return undefined;

  return {
    type: "ApplyAttributeOperations",
    data: {
      selection,
      operations,
      transitions: {},
      transitions_by_attribute: {},
    },
  };
}

/** Builds independently scoped commands without forming a fixture/attribute Cartesian product. */
export function blueprintApplicationCommands(
  blueprintId: number,
  scopes: readonly BlueprintApplicationScope[],
  resolution: types.BlueprintResolution,
): types.ProgrammerCommand[] {
  return scopes.flatMap((scope) => {
    const command = blueprintApplicationCommand(
      blueprintId,
      scope.targets,
      resolution,
      scope.selection,
    );
    return command ? [command] : [];
  });
}
