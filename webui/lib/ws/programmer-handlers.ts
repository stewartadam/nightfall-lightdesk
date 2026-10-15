// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  blueprintDependencies,
  blueprints,
  type ElementProgrammerRow,
  type ProgrammerRow,
  programmerResolvedSelection,
  programmerSelection,
  programmerSpatialSelection,
  programmerState,
} from "../../state/appStores";
import type * as types from "../../types";
import { getLogger } from "../logger";
import { setStoreAction } from "../nanostore-action";
import { valueSourceToProcessedParameterValue } from "../value-source";
import { arrayToUidMap } from "./handler-utils";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

const log = getLogger(import.meta.url);

/** Processed programmer attribute value shown in programmer rows. */
type ProgrammerAttributeValue = ProgrammerRow["attributes"][string];

/** Programmer state message payload as typeshared from the backend. */
type ProgrammerStateData = Extract<
  AnyWsMessage,
  { type: "ProgrammerState" }
>["data"];

/** Registers programmer state, selection, and blueprint handlers. */
export function registerProgrammerHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ProgrammerState", (message) => {
    setStoreAction(
      programmerState,
      "Receive ProgrammerState",
      programmerRowsFromState(message.data),
    );
  });

  registry.register("ProgrammerSelection", (message) => {
    setStoreAction(
      programmerSelection,
      "Receive ProgrammerSelection",
      message.data,
    );
  });

  registry.register("ProgrammerSpatialSelection", (message) => {
    setStoreAction(
      programmerSpatialSelection,
      "Receive ProgrammerSpatialSelection",
      message.data.selection,
    );
    setStoreAction(
      programmerResolvedSelection,
      "Receive ProgrammerSpatialSelection",
      message.data.resolved,
    );
  });

  registry.register("BlueprintDefinitions", (message) => {
    setStoreAction(
      blueprints,
      "Receive BlueprintDefinitions",
      arrayToUidMap(message.data),
    );
  });

  registry.register("BlueprintDependencies", (message) => {
    setStoreAction(
      blueprintDependencies,
      "Receive BlueprintDependencies",
      Object.fromEntries(
        message.data.map((entry) => [entry.blueprint_uid, entry.dependents]),
      ),
    );
  });

  registry.register("BlueprintCommand", (message) => {
    handleBlueprintCommand(message.data as unknown as types.BlueprintCommand);
  });
}

/**
 * Converts backend programmer state into per-fixture display rows: each row
 * merges element values (last element wins), keeps per-element rows for
 * multi-element fixtures, and flags attributes whose element values differ.
 */
function programmerRowsFromState(data: ProgrammerStateData): ProgrammerRow[] {
  return Object.values(data).map((item) => {
    // Track conflicts: attribute -> Set of unique formatted values
    const conflictTracker: Record<string, Set<string>> = {};
    const mergedParams: Record<string, ProgrammerAttributeValue> = {};
    const elements: ElementProgrammerRow[] = [];

    // Process per-element data with conflict tracking
    for (
      let elementIdx = 0;
      elementIdx < item.parameters.length;
      elementIdx++
    ) {
      const elementParams = item.parameters[elementIdx];
      const elementAttrs: Record<string, ProgrammerAttributeValue> = {};

      for (const [attr, value] of Object.entries(elementParams.parameters)) {
        const attrValue = valueSourceToProcessedParameterValue(
          value as types.ValueSource,
        );
        if (!attrValue) continue;
        attrValue.blueprintSource = elementParams.blueprint_sources[attr];
        elementAttrs[attr] = attrValue;

        // Track conflict using stringified value (to compare objects)
        const valueKey = JSON.stringify(attrValue);
        if (!conflictTracker[attr]) conflictTracker[attr] = new Set();
        conflictTracker[attr].add(valueKey);

        // Aggregated value (last element wins)
        mergedParams[attr] = attrValue;
      }

      elements.push({
        elementIndex: elementIdx + 1, // 1-based
        attributes: elementAttrs,
      });
    }

    // Identify conflicts (attributes with >1 unique value)
    const conflicts = new Set<string>();
    for (const [attr, values] of Object.entries(conflictTracker)) {
      if (values.size > 1) {
        conflicts.add(attr);
      }
    }

    return {
      fixtureUid: item.fixture_uid,
      attributes: mergedParams,
      elements: elements.length > 1 ? elements : undefined,
      conflicts: conflicts.size > 0 ? conflicts : undefined,
    };
  });
}

/** Ignores optimistic blueprint mutations in favor of backend provider snapshots. */
function handleBlueprintCommand(command: types.BlueprintCommand) {
  log.trace("Handling BlueprintCommand:", command);

  // CRUD commands (StoreBlueprint, RenameBlueprint, DeleteBlueprint) are not processed here.
  // Instead, we receive full BlueprintDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  log.trace(
    "Ignoring BlueprintCommand (handled via BlueprintDefinitions):",
    command.type,
  );
}
