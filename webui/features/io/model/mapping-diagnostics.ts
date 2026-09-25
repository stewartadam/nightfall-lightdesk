// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { type GridCell, GridCellKind } from "../../../lib/data-grid-types";
import type { BindingDiagnostic, InvocationError } from "../../../types";

/**
 * Looks up backend binding diagnostics by the ID of the mapping they describe.
 *
 * Mapping IDs may arrive as UUID strings or, over the binary transport, as UUID bytes, so
 * both sides are normalized to unhyphenated hex before comparing.
 */
export function diagnosticsByMapping(
  diagnostics: readonly BindingDiagnostic[],
): (mappingId: unknown) => InvocationError | undefined {
  const errors = new Map(
    diagnostics.map((diagnostic) => [
      normalizeFixtureUid(diagnostic.binding_id),
      diagnostic.error,
    ]),
  );
  return (mappingId) => errors.get(normalizeFixtureUid(mappingId));
}

/**
 * Builds the read-only status cell of one mapping row.
 *
 * A diagnosed mapping shows its failure message behind an error tag whose accessible
 * label repeats the message; a mapping without a diagnostic shows "OK".
 */
export function mappingStatusCell(
  error: InvocationError | undefined,
): GridCell {
  if (!error) {
    return {
      kind: GridCellKind.Text,
      data: "OK",
      displayData: "OK",
      allowOverlay: false,
      readonly: true,
    };
  }
  return {
    kind: GridCellKind.Text,
    data: error.message,
    displayData: error.message,
    allowOverlay: false,
    readonly: true,
    stateIndicators: [
      {
        label: `Mapping problem: ${error.message}`,
        tone: "error",
        variant: "tag",
        text: "!",
      },
    ],
  };
}

/** Returns the status text a mapping row filters by: its failure message, or "OK". */
export function mappingStatusText(error: InvocationError | undefined): string {
  return error?.message ?? "OK";
}
