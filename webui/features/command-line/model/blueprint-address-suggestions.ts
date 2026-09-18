// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { RankedCommandSuggestion } from "../../../lib/command-autocomplete";
import type { CommandAutocompleteObjectReferenceRequest } from "../../../lib/wasm-bridge";
import type * as types from "../../../types";

/** Fills parser-issued Blueprint address requests with IDs and labels from the current Blueprint inventory using their supplied edit templates. */
export function blueprintAddressSuggestions(
  requests: readonly CommandAutocompleteObjectReferenceRequest[],
  blueprintMap: Record<string, types.Blueprint>,
): RankedCommandSuggestion[] {
  const values = Object.values(blueprintMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
  return requests
    .filter((request) => request.object_kind === "blueprint")
    .flatMap((request) => {
      const prefix = request.query.toLowerCase();
      return values.flatMap((blueprint): RankedCommandSuggestion[] => {
        const id = blueprint.identifiers.id.toString();
        const label = blueprint.identifiers.label;
        const quotedLabel = JSON.stringify(label);
        if (
          prefix &&
          !id.includes(prefix) &&
          !label.toLowerCase().includes(prefix)
        )
          return [];
        return (
          [
            {
              kind: "token",
              candidateId: `${request.id}:id:${id}`,
              label: `Blueprint ${id}`,
              detail: label,
              insertText: id,
              applyText: `${request.before_value}${id}${request.after_value}`,
              replace: request.replace,
              completable: true,
            },
            {
              kind: "token",
              candidateId: `${request.id}:label:${id}`,
              label,
              detail: `Blueprint ${id}`,
              insertText: quotedLabel,
              applyText: `${request.before_value}${quotedLabel}${request.after_value}`,
              replace: request.replace,
              completable: true,
            },
          ] satisfies RankedCommandSuggestion[]
        ).filter(
          (suggestion) =>
            !prefix ||
            suggestion.label.toLowerCase().includes(prefix) ||
            suggestion.insertText.toLowerCase().includes(prefix),
        );
      });
    });
}
