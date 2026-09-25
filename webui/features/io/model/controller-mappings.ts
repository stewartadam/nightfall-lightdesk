// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  commandFailureMessage,
  commandOutputValue,
  commandSucceeded,
} from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { pushToast } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  actionInputKind,
  actionTargetNamesSnapshot,
  bindableActionCatalogSnapshot,
  formatActionReference,
} from "../../actions";
import { plain } from "./controller-mapping-builders";
import {
  type DescribedMapping,
  describeReplacedMappings,
  formatReplacedNotice,
} from "./mapping-replacements";

/**
 * Sends a mapping command and surfaces rejected edits as a toast.
 *
 * Returns the command's output value on success (undefined when it carries none), or null
 * when the command failed.
 */
async function submitMappingCommand(
  module: "MidiCommand" | "OscCommand",
  command: types.MidiCommand | types.OscCommand,
): Promise<unknown | null> {
  const result = await engineRuntime.sendCommandAndAwait({
    module,
    command: plain(command),
  });
  if (!commandSucceeded(result)) {
    pushToast("error", commandFailureMessage(result));
    return null;
  }
  return commandOutputValue(result);
}

/**
 * Reads the mappings an upsert replaced from its command output, shaped as
 * `MidiMappingUpserted` or `OscMappingUpserted`.
 */
function replacedFromOutput<M>(output: unknown): M[] {
  const replaced = (output as { replaced?: M[] } | undefined)?.replaced;
  return Array.isArray(replaced) ? replaced : [];
}

/**
 * Creates or replaces a MIDI mapping; other mappings on the same control are removed.
 *
 * Resolves to the mappings the upsert replaced, or null when it was rejected.
 */
export async function upsertMidiMapping(
  mapping: types.MidiMapping,
): Promise<types.MidiMapping[] | null> {
  const output = await submitMappingCommand("MidiCommand", {
    type: "UpsertMapping",
    data: mapping,
  });
  return output === null ? null : replacedFromOutput<types.MidiMapping>(output);
}

/** Deletes a MIDI mapping by ID and resolves to whether it was deleted. */
export async function deleteMidiMapping(id: string): Promise<boolean> {
  const output = await submitMappingCommand("MidiCommand", {
    type: "DeleteMapping",
    data: id,
  });
  return output !== null;
}

/**
 * Creates or replaces an OSC mapping; mappings with the same criteria are removed.
 *
 * Resolves to the mappings the upsert replaced, or null when it was rejected.
 */
export async function upsertOscMapping(
  mapping: types.OscMapping,
): Promise<types.OscMapping[] | null> {
  const output = await submitMappingCommand("OscCommand", {
    type: "UpsertMapping",
    data: mapping,
  });
  return output === null ? null : replacedFromOutput<types.OscMapping>(output);
}

/** Deletes an OSC mapping by ID and resolves to whether it was deleted. */
export async function deleteOscMapping(id: string): Promise<boolean> {
  const output = await submitMappingCommand("OscCommand", {
    type: "DeleteMapping",
    data: id,
  });
  return output !== null;
}

/** Labels replaced mappings using the current action catalog and target names. */
export function replacedMappingLabels(
  replaced: readonly DescribedMapping[],
): string[] {
  const catalog = bindableActionCatalogSnapshot();
  const names = actionTargetNamesSnapshot();
  return describeReplacedMappings(
    replaced,
    (action) => formatActionReference(action, catalog, names),
    (action) => actionInputKind(catalog, action),
  );
}

/** Tells the operator which mappings an edit replaced, when it replaced any. */
export function announceReplacedMappings(
  replaced: readonly DescribedMapping[] | null,
): void {
  if (replaced && replaced.length > 0) {
    pushToast("info", formatReplacedNotice(replacedMappingLabels(replaced)));
  }
}
