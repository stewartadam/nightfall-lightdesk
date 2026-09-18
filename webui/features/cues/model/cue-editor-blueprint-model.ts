// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ProjectedCueInstructionValues } from "../../../lib/cue-value-projection";
import type { ProcessedParameterValue } from "../../../lib/datagrid";
import type * as types from "../../../types";
import { selectedBlueprintValues } from "../../blueprints";

export type ReferencedBlueprintInstructionTarget = {
  partIndex?: number;
  selectionIndex: number;
  blueprintUid: string;
};

export interface CueAssertionRow {
  type: "parent" | "element";
  attributes: ProjectedCueInstructionValues;
  applicableAttributes?: ReadonlySet<string>;
  selectedElementRows?: CueAssertionRow[];
}

/** Resolves operator-facing provenance for one live Blueprint instruction. */
export function blueprintValueSourceForInstruction(
  instruction: types.CueInstruction,
  blueprintMap: Record<string, types.Blueprint>,
): types.OutboundBlueprintValueSource | undefined {
  const application = instruction.blueprint_application;
  if (!application) return undefined;
  const blueprint = blueprintMap[application.blueprint_uid];
  if (!blueprint) return undefined;
  return {
    blueprint_uid: blueprint.identifiers.uid,
    blueprint_id: blueprint.identifiers.id,
    blueprint_label: blueprint.identifiers.label,
    selector: application.selector,
  };
}

/** Attaches one live Blueprint's provenance to every projected value it supplies. */
export function applyBlueprintValueSource(
  attributes: ProjectedCueInstructionValues,
  blueprintSource: types.OutboundBlueprintValueSource | undefined,
): ProjectedCueInstructionValues {
  if (!blueprintSource) return attributes;
  const attach = (
    values: Record<string, ProcessedParameterValue>,
  ): Record<string, ProcessedParameterValue> =>
    Object.fromEntries(
      Object.entries(values).map(([attr, value]) => [
        attr,
        { ...value, blueprintSource },
      ]),
    );
  return {
    abs: attach(attributes.abs),
    rel: attach(attributes.rel),
    release: attributes.release,
  };
}

/** Formats one cue assertion for aggregation and conflict descriptions. */
export function formatCueAssertionValue(
  row: CueAssertionRow,
  attr: string,
  options: { ignoreDisplayOnlyBlockMarker?: boolean } = {},
): string {
  if (row.attributes.release.has(attr)) return "R";
  const relativeValue = row.attributes.rel[attr];
  const value = relativeValue ?? row.attributes.abs[attr];
  if (!value) return "";

  const marker =
    options.ignoreDisplayOnlyBlockMarker && value.marker === "block"
      ? undefined
      : value.marker;
  const markerPrefix =
    marker === "release"
      ? "R"
      : marker === "hold"
        ? "H"
        : marker === "block"
          ? "B"
          : "";
  if (value.value === undefined) return markerPrefix;

  const prefix = relativeValue ? "~" : "";
  const displayValue = value.isPercentage ? value.value * 100 : value.value;
  const suffix = value.isPercentage ? "%" : "";
  return `${markerPrefix ? `${markerPrefix} ` : ""}${prefix}${displayValue}${suffix}`;
}

/** Returns the concrete assertion carried by one row for an attribute. */
export function cueRowAssertionValue(
  row: CueAssertionRow,
  attr: string,
): ProcessedParameterValue | undefined {
  return row.attributes.rel[attr] ?? row.attributes.abs[attr];
}

/** Builds an identity that distinguishes equal values from different Blueprints. */
export function cueRowAssertionIdentity(
  row: CueAssertionRow,
  attr: string,
): string | undefined {
  if (row.attributes.release.has(attr)) return "release";
  const value = cueRowAssertionValue(row, attr);
  if (!value) return undefined;
  return `${formatCueAssertionValue(row, attr, { ignoreDisplayOnlyBlockMarker: true })}:${value.blueprintSource?.blueprint_uid ?? "direct"}`;
}

/** Returns a uniform child assertion suitable for display on its parent row. */
export function aggregateParentElementAssertion(
  row: CueAssertionRow,
  attr: string,
): ProcessedParameterValue | undefined {
  if (row.type !== "parent" || !row.selectedElementRows?.length) {
    return undefined;
  }
  const applicableRows = row.selectedElementRows.filter(
    (elementRow) => elementRow.applicableAttributes?.has(attr) ?? true,
  );
  const assertions = applicableRows.map((elementRow) => ({
    identity: cueRowAssertionIdentity(elementRow, attr),
    value: cueRowAssertionValue(elementRow, attr),
  }));
  const first = assertions[0];
  if (!first?.identity || !first.value) return undefined;
  if (
    !assertions.every(
      (entry) => entry.identity === first.identity && entry.value !== undefined,
    )
  ) {
    return undefined;
  }
  const hasBlockMarker = assertions.some(
    (entry) => entry.value?.marker === "block",
  );
  const allHaveBlockMarker = assertions.every(
    (entry) => entry.value?.marker === "block",
  );
  return hasBlockMarker && !allHaveBlockMarker
    ? { ...first.value, marker: undefined }
    : first.value;
}

/** Returns whether a parent row's concrete child assertions differ. */
export function parentElementAssertionsVaried(
  row: CueAssertionRow,
  attr: string,
): boolean {
  if (row.type !== "parent" || !row.selectedElementRows?.length) return false;
  const identities = new Set(
    row.selectedElementRows
      .filter(
        (elementRow) => elementRow.applicableAttributes?.has(attr) ?? true,
      )
      .map(
        (elementRow) => cueRowAssertionIdentity(elementRow, attr) ?? "missing",
      ),
  );
  return identities.size > 1;
}

/** Replaces selected live Blueprint instructions with their current direct values. */
export function makeBlueprintInstructionsAbsolute(
  cue: types.Cue,
  targets: readonly ReferencedBlueprintInstructionTarget[],
  blueprintMap: Record<string, types.Blueprint>,
): boolean {
  let changed = false;
  for (const target of targets) {
    const instructions =
      target.partIndex === undefined
        ? cue.instructions
        : cue.parts?.[target.partIndex]?.instructions;
    const instruction = instructions?.[target.selectionIndex]?.cue_instruction;
    const application = instruction?.blueprint_application;
    const blueprint = application
      ? blueprintMap[application.blueprint_uid]
      : undefined;
    if (
      !instruction ||
      !application ||
      !blueprint ||
      application.blueprint_uid !== target.blueprintUid
    ) {
      continue;
    }
    instruction.values = selectedBlueprintValues(
      blueprint,
      application.selector,
    );
    delete instruction.blueprint_application;
    changed = true;
  }
  return changed;
}
