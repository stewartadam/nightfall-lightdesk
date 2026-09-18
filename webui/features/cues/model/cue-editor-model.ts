// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { sortedAttributes } from "../../../lib/attribute-ordering";
import {
  ensureInstructionForFixtureRef,
  findInstructionForFixtureRef,
  singleResolvedInstructionFixtureRef,
} from "../../../lib/cue-instruction-edit";
import {
  type CueTimingValue,
  createTransitionModeResolver,
  resolveCueInstructionTiming,
  resolvedSelectionTimingIndexes,
  type SelectionTimingPosition,
  sameFixtureUid,
  selectionTimingPositionForFixtureAttribute,
  TIMING_COLUMNS,
  type TimingField,
  type TransitionModeResolver,
  upsertInstructionFixtureAttributeTiming,
} from "../../../lib/cue-timing-values";
import { projectCueInstructionValuesForFixtureRef } from "../../../lib/cue-value-projection";
import type { GridCell, GridColumn } from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  createAttributeValueCell,
  type ElementRowExtension,
  type ExpandableRowExtension,
  type ProcessedParameterValue,
} from "../../../lib/datagrid";
import {
  attributeColumnVisibilityMeta,
  type DataGridColumnVisibilityMeta,
} from "../../../lib/datagrid-column-visibility";
import {
  isRichTimeCell,
  type RichTimeCell,
} from "../../../lib/datagrid-rich-cells";
import {
  getFixtureAttributeNames,
  getFixtureElementAttributeNames,
} from "../../../lib/fixture-attributes";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  fixtureRefKey,
  resolvedFixtureRefsForSelection,
} from "../../../lib/selection-resolution";
import { normalizeAttributeName } from "../../../lib/utils";
import {
  parameterValueForValueSource,
  parameterValueToProcessedParameterValue,
} from "../../../lib/value-source";
import {
  type LookaheadProjectionCue,
  type LookaheadProjectionInstruction,
  type ProjectedLookaheadValue,
  projectSequenceLookahead,
} from "../../../lib/wasm-bridge";
import type * as types from "../../../types";
import { ObjectType } from "../../../types";
import { selectedBlueprintValues } from "../../blueprints";
import type { PlaybackTransitionClock } from "../../cue-sequences";
import { formatCueEditorTitle } from "../context/cue-editor-context";
import {
  applyBlueprintValueSource,
  blueprintValueSourceForInstruction,
  cueRowAssertionValue,
  formatCueAssertionValue,
} from "./cue-editor-blueprint-model";

export type ProcessedCueData = {
  groups: never[];
  flatRows: CueFixtureRow[];
};
export const TRACKED_VALUE_CLEARED = Symbol("tracked-value-cleared");
export type TrackedCueValue =
  | types.ParameterValue
  | typeof TRACKED_VALUE_CLEARED;
export type TrackedCueSource = {
  label: string;
  cueUid: string;
  cueId?: number;
  sequenceId: number;
  sequenceUid?: string;
  partId: number;
  hasAdditionalParts?: boolean;
  setupSequenceUid?: string;
};
export type TrackedCueEntry = {
  value: TrackedCueValue;
  source: TrackedCueSource;
};
export type TrackedCueValues = Map<string, TrackedCueEntry>;
export type LookaheadCueEntry = {
  value: types.ParameterValue;
  source: TrackedCueSource;
};
export type LookaheadCueValues = Map<string, LookaheadCueEntry>;

export interface CueEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialCueUid: string;
  initialPartId?: number;
  initialSequenceId?: number;
  initialSequenceUid?: string;
  closeOnSequenceDelete?: boolean;
  initialSetupSequenceUid?: string;
  initialReleaseSequenceUid?: string;
}

export type DisplayMode = "values" | "timings";

export type CueGridColumn = GridColumn & {
  cueAttribute?: string;
  cueColumnKind?: "value" | "timing";
  cueTimingField?: TimingField;
} & DataGridColumnVisibilityMeta;

export type CueValueConflictWriter = {
  sourceLabel: string;
  instructionIndex: number;
  valueLabel: string;
};

export type CueValueConflict = {
  attribute: string;
  fixtureLabel: string;
  writers: CueValueConflictWriter[];
  winningWriter: CueValueConflictWriter;
};

export type CueCellTooltipState = {
  id: number;
  content: string;
  anchorRect: DOMRect;
};

export type CueFixtureRowBase = {
  uid: string;
  id: number;
  sourceLabel: string;
  label: string;
  selectionIndex: number; // Reference to which instruction this fixture belongs to
  instructionTargets: CueInstructionRowTarget[];
  partIndex?: number;
  partLabel?: string;
  fixtureRef: types.FixtureRef;
  applicableAttributes: Set<string>;
  attributes: {
    abs: Record<string, ProcessedParameterValue>;
    rel: Record<string, ProcessedParameterValue>;
    release: Set<string>;
  };
  trackedAttributes: Record<string, ProcessedParameterValue>;
  trackedAttributeSources: Record<string, TrackedCueSource>;
  lookaheadAttributes: Record<string, ProcessedParameterValue>;
  lookaheadAttributeSources: Record<string, TrackedCueSource>;
  conflictingValues: Set<string>;
  valueConflicts: Map<string, CueValueConflict>;
  transitions: Record<string, Partial<Record<TimingField, CueTimingValue>>>;
  colorPathId?: number | null;
};

export type CueParentRow = CueFixtureRowBase &
  ExpandableRowExtension & {
    fixtureUid: string;
    expansionKey: string;
    selectedElementRows: CueElementRow[];
  };

export type CueElementRow = CueFixtureRowBase &
  ElementRowExtension & {
    expansionKey: string;
  };

export type CueFixtureRow = CueParentRow | CueElementRow;

export type CueInstructionRowTarget = {
  partIndex?: number;
  selectionIndex: number;
  fixtureRef: types.FixtureRef;
};

export type TimingFanEditMode = "across-rows" | "within-groups";
export type TimingFanEditResult =
  | "not-fan"
  | "invalid"
  | "unchanged"
  | "changed";
export type TimingClearScope = "parent" | "parent-and-children";

export type TimingFanEditMember = {
  targets: CueInstructionRowTarget[];
};

export const TIMING_FAN_TOOLTIP =
  "Applying across fixtures, press Shift+Enter to apply within fixtures";

/** Creates a stable key for de-duping timing edit targets. */
export function timingEditTargetKey(target: CueInstructionRowTarget): string {
  return `${target.partIndex ?? "parent"}:${target.selectionIndex}:${fixtureRefKey(target.fixtureRef)}`;
}

/** Returns timing edit targets without duplicates while preserving input order. */
export function uniqueTimingTargets(
  targets: readonly CueInstructionRowTarget[],
): CueInstructionRowTarget[] {
  const seen = new Set<string>();
  const unique: CueInstructionRowTarget[] = [];
  for (const target of targets) {
    if (target.selectionIndex < 0) continue;
    const key = timingEditTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

/** Returns the fixture-wide target corresponding to a concrete row edit target. */
export function fixtureWideTimingTarget(
  target: CueInstructionRowTarget,
): CueInstructionRowTarget {
  return {
    ...target,
    fixtureRef: { fixture_uid: target.fixtureRef.fixture_uid },
  };
}

/** Returns element-specific timing targets represented by a parent row. */
export function parentElementTimingTargets(
  row: CueFixtureRow,
  attr: string,
): CueInstructionRowTarget[] {
  if (row.type !== "parent" || row.selectedElementRows.length === 0) {
    return [];
  }

  return uniqueTimingTargets(
    row.selectedElementRows
      .filter((elementRow) => elementRow.applicableAttributes.has(attr))
      .flatMap((elementRow) => elementRow.instructionTargets),
  );
}

/** Returns fixture-wide timing targets represented by a parent row's element rows. */
export function parentElementFixtureWideTimingTargets(
  row: CueFixtureRow,
  attr: string,
): CueInstructionRowTarget[] {
  if (
    row.type !== "parent" ||
    row.selectedElementRows.length === 0 ||
    !row.applicableAttributes.has(attr)
  ) {
    return [];
  }

  return uniqueTimingTargets(
    row.selectedElementRows
      .filter((elementRow) => elementRow.applicableAttributes.has(attr))
      .flatMap((elementRow) => elementRow.instructionTargets)
      .map(fixtureWideTimingTarget),
  );
}

/** Returns whether a parent row represents grouped element refs instead of a whole fixture. */
export function parentRowUsesElementTargets(
  row: CueFixtureRow,
): row is CueParentRow {
  return (
    row.type === "parent" &&
    row.selectedElementRows.length > 0 &&
    row.instructionTargets.length > 0 &&
    row.instructionTargets.every(
      (target) => !isWholeFixtureRef(target.fixtureRef),
    )
  );
}

/** Returns concrete value edit targets represented by a row for one attribute. */
export function valueTargetsForRowAttribute(
  row: CueFixtureRow,
  attr: string,
): CueInstructionRowTarget[] {
  if (parentRowUsesElementTargets(row)) {
    return uniqueTimingTargets(
      row.selectedElementRows
        .filter((elementRow) => elementRow.applicableAttributes.has(attr))
        .flatMap((elementRow) => elementRow.instructionTargets),
    );
  }

  if (!row.applicableAttributes.has(attr)) return [];
  return row.instructionTargets.length > 0
    ? uniqueTimingTargets(row.instructionTargets)
    : [
        {
          partIndex: row.partIndex,
          selectionIndex: row.selectionIndex,
          fixtureRef: row.fixtureRef,
        },
      ];
}

/** Returns whether a row can display or edit one attribute value. */
export function rowSupportsValueAttribute(
  row: CueFixtureRow,
  attr: string,
): boolean {
  return valueTargetsForRowAttribute(row, attr).length > 0;
}

/** Returns concrete timing edit targets represented by a visible cue row. */
export function timingTargetsForRow(
  row: CueFixtureRow,
): CueInstructionRowTarget[] {
  if (parentRowUsesElementTargets(row)) {
    return uniqueTimingTargets(
      row.selectedElementRows.flatMap(
        (elementRow) => elementRow.instructionTargets,
      ),
    );
  }

  return uniqueTimingTargets(
    row.instructionTargets.length > 0
      ? row.instructionTargets
      : [
          {
            partIndex: row.partIndex,
            selectionIndex: row.selectionIndex,
            fixtureRef: row.fixtureRef,
          },
        ],
  );
}

/** Returns concrete timing edit targets for a row that can carry one attribute. */
export function timingTargetsForRowAttribute(
  row: CueFixtureRow,
  attr: string,
): CueInstructionRowTarget[] {
  if (parentRowUsesElementTargets(row)) {
    return uniqueTimingTargets(
      row.selectedElementRows
        .filter((elementRow) => elementRow.applicableAttributes.has(attr))
        .flatMap((elementRow) => elementRow.instructionTargets),
    );
  }

  return row.applicableAttributes.has(attr) ? timingTargetsForRow(row) : [];
}

/** Returns concrete and legacy parent targets that should be cleared for one timing cell. */
export function timingClearTargetsForRowAttribute(
  row: CueFixtureRow,
  attr: string,
  scope: TimingClearScope = "parent",
): CueInstructionRowTarget[] {
  const targets = timingTargetsForRowAttribute(row, attr);
  if (
    scope === "parent" ||
    row.type !== "parent" ||
    row.selectedElementRows.length === 0 ||
    !row.applicableAttributes.has(attr)
  ) {
    return targets;
  }

  return uniqueTimingTargets([
    ...targets,
    ...parentElementTimingTargets(row, attr),
    ...parentElementFixtureWideTimingTargets(row, attr),
  ]);
}

/** Returns whether a row is fully covered by selected parent-row edit targets. */
export function rowCoveredByParentTargets(
  row: CueFixtureRow,
  attr: string,
  parentTargetKeys: ReadonlySet<string>,
): boolean {
  const targets = timingTargetsForRowAttribute(row, attr);
  return (
    targets.length > 0 &&
    targets.every((target) => parentTargetKeys.has(timingEditTargetKey(target)))
  );
}

/** Applies fixed timing to every concrete target represented by one fan member. */
export function applyFixedTimingToFanMember(
  cue: types.Cue,
  member: TimingFanEditMember,
  attr: string,
  field: TimingField,
  duration: types.Duration,
): boolean {
  let changed = false;
  for (const target of member.targets) {
    const instructionContainer =
      target.partIndex === undefined
        ? cue.instructions
        : cue.parts?.[target.partIndex]?.instructions;
    const instruction =
      instructionContainer?.[target.selectionIndex]?.cue_instruction;
    if (!instruction) continue;
    upsertInstructionFixtureAttributeTiming(
      instruction,
      target.fixtureRef,
      attr,
      field,
      {
        type: "Fixed",
        data: duration,
      },
    );
    changed = true;
  }
  return changed;
}

/**
 * Orders displayed cue rows by fixture ID while keeping expanded element rows attached.
 */
export function compareCueFixtureRowsById(
  left: CueFixtureRow,
  right: CueFixtureRow,
): number {
  const idOrder = left.id - right.id;
  if (idOrder !== 0) return idOrder;

  const partOrder = (left.partIndex ?? -1) - (right.partIndex ?? -1);
  if (partOrder !== 0) return partOrder;

  const selectionOrder = left.selectionIndex - right.selectionIndex;
  if (selectionOrder !== 0) return selectionOrder;

  if (left.type !== right.type) {
    return left.type === "parent" ? -1 : 1;
  }

  if (left.type === "element" && right.type === "element") {
    const elementOrder = left.elementIndex - right.elementIndex;
    if (elementOrder !== 0) return elementOrder;
  }

  return left.uid.localeCompare(right.uid);
}

export const INHERITED_TIMING_TEXT_COLOR = "#8f8f8f";

/** Narrows a grid cell to the rich duration editor cell used by timing columns. */
export function isTimeCell(cell: GridCell): cell is RichTimeCell {
  return cell.kind === GridCellKind.Custom && isRichTimeCell(cell);
}

/** Clamps a numeric progress value into a bounded range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Applies path-driven styling to emitter cells generated by a logical color transition. */
export function applyColorPathDrivenStyling(
  cell: GridCell,
  colorPathId: number | null | undefined,
): GridCell {
  if (colorPathId == null) return cell;
  return {
    ...cell,
    themeOverride: {
      ...cell.themeOverride,
      bgCell: "#12343b",
      bgCellMedium: "#164e57",
      textDark: "#a5f3fc",
    },
  };
}

/** Formats a cue editor row value for conflict explanations. */
export function formatCueConflictValue(
  row: CueFixtureRow,
  attr: string,
): string {
  return formatCueAssertionValue(row, attr);
}

/** Builds the per-row writer label shown in conflict tooltips. */
export function conflictWriterLabel(writer: CueValueConflictWriter): string {
  return `${writer.sourceLabel} @ ${writer.valueLabel}`;
}

/** Builds the lingering hover copy for a cue value conflict. */
export function cueValueConflictTooltip(conflict: CueValueConflict): string {
  const writerLines = conflict.writers
    .map((writer) => conflictWriterLabel(writer))
    .join(" and ");
  return [
    `${conflict.attribute} is asserted by ${writerLines}, with ${conflict.winningWriter.sourceLabel} winning.\n`,
    "Cue parts fire together; later materialized rows override earlier values.",
  ].join("\n");
}

/** Converts an attribute name into a stable grid key segment. */
export function cueAttributeKey(attribute: string): string {
  const slug = normalizeAttributeName(attribute)
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "attribute";
}

/** Converts a timing field enum value into a stable grid key segment. */
export function cueTimingFieldKey(field: TimingField): string {
  return field.replace(/_/g, "-");
}

/** Builds the canonical grid column key for one cue attribute value. */
export function cueAttributeValueColumnId(attribute: string): string {
  return `attribute:${cueAttributeKey(attribute)}:value`;
}

/** Builds the canonical grid column key for one cue attribute timing field. */
export function cueAttributeTimingColumnId(
  attribute: string,
  field: TimingField,
): string {
  return `attribute:${cueAttributeKey(attribute)}:timing:${cueTimingFieldKey(field)}`;
}

/** Builds cue column visibility metadata with cue-specific default visibility. */
export function cueColumnVisibilityMeta(
  attribute: string,
  label: string,
  defaultVisible: boolean,
): DataGridColumnVisibilityMeta {
  return {
    ...attributeColumnVisibilityMeta(attribute, label),
    defaultVisible,
  };
}

/** Parses a generated timing column ID into attribute-key and timing field parts. */
export function parseTimingColumnId(
  columnId: string,
): { attr: string; field: TimingField } | undefined {
  const canonicalMatch = columnId.match(
    /^attribute:([^:]+):timing:(fade-in|delay-in|fade-out|delay-out)$/,
  );
  if (canonicalMatch) {
    return {
      attr: canonicalMatch[1],
      field: canonicalMatch[2].replace(/-/g, "_") as TimingField,
    };
  }
  const match = columnId.match(/^(.+)_(fade_in|delay_in|fade_out|delay_out)$/);
  if (!match) return undefined;
  return { attr: match[1], field: match[2] as TimingField };
}

/** Parses a generated value column ID into its attribute key part. */
export function parseValueColumnId(
  columnId: string,
): { attr: string } | undefined {
  const canonicalMatch = columnId.match(/^attribute:([^:]+):value$/);
  if (canonicalMatch) return { attr: canonicalMatch[1] };
  const match = columnId.match(/^(.+)_Value$/);
  if (!match) return undefined;
  return { attr: match[1] };
}

/** Builds the tracked-value lookup key for one fixture attribute. */
export function trackedCueValueKey(
  ref: types.FixtureRef,
  attr: string,
): string {
  return `${fixtureRefKey(ref)}:${normalizeAttributeName(attr)}`;
}

/** Returns whether a fixture ref targets the whole fixture. */
export function isWholeFixtureRef(ref: types.FixtureRef): boolean {
  return ref.index === null || ref.index === undefined;
}

/** Creates an editable empty value cell for supported attributes without assertions. */
export function makeEditableTrackedEmptyValueCell(): GridCell {
  return createAttributeValueCell(undefined, { allowOverlay: true });
}

/** Removes element-scoped tracked values superseded by a whole-fixture write. */
export function deleteTrackedElementValues(
  tracked: TrackedCueValues,
  ref: types.FixtureRef,
  attr: string,
): void {
  if (!isWholeFixtureRef(ref)) return;
  const prefix = `${ref.fixture_uid}:`;
  const suffix = `:${normalizeAttributeName(attr)}`;
  for (const key of tracked.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      tracked.delete(key);
    }
  }
}

/** Resolves current logical values for a direct or live Blueprint instruction. */
export function resolvedBlueprintInstructionValues(
  instruction: types.CueInstruction,
  blueprintMap: Record<string, types.Blueprint>,
): Record<string, types.ValueSource> {
  const application = instruction.blueprint_application;
  if (!application) return instruction.values;
  const blueprint = blueprintMap[application.blueprint_uid];
  if (!blueprint) return {};
  return selectedBlueprintValues(blueprint, application.selector);
}

/** Applies one stored instruction to the tracked-value lookup. */
export async function trackInstructionValues(
  tracked: TrackedCueValues,
  instruction: types.BoundCueInstruction,
  trackedSource: TrackedCueSource,
  blueprintMap: Record<string, types.Blueprint> = {},
): Promise<void> {
  const fixtures = await resolvedFixtureRefsForSelection(instruction.selection);
  const values = resolvedBlueprintInstructionValues(
    instruction.cue_instruction,
    blueprintMap,
  );
  for (const [selectionIndex, fixture] of fixtures.entries()) {
    for (const [attr, valueSource] of Object.entries(values)) {
      const key = trackedCueValueKey(fixture, attr);
      if (valueSource.type === "Inline" || valueSource.type === "Fanned") {
        const value = parameterValueForValueSource(
          valueSource,
          selectionIndex,
          fixtures.length,
        );
        if (value) {
          deleteTrackedElementValues(tracked, fixture, attr);
          tracked.set(key, { value, source: trackedSource });
        }
        continue;
      }
      if (valueSource.type === "Release") {
        deleteTrackedElementValues(tracked, fixture, attr);
        if (isWholeFixtureRef(fixture)) {
          tracked.delete(key);
        } else {
          tracked.set(key, {
            value: TRACKED_VALUE_CLEARED,
            source: trackedSource,
          });
        }
      }
    }
  }
}

/** Computes values tracked into a cue before the cue's own instructions run. */
export async function trackedValuesBeforeCue(
  sequence: types.Sequence | undefined,
  cueMap: Record<string, types.Cue>,
  targetCue: types.Cue,
  blueprintMap: Record<string, types.Blueprint> = {},
): Promise<TrackedCueValues> {
  const tracked: TrackedCueValues = new Map();
  if (!sequence || targetCue.identifiers.id === 0) return tracked;

  const targetIndex = sequence.steps.indexOf(targetCue.identifiers.uid);
  if (targetIndex < 0) return tracked;

  const sequenceId = sequence.identifiers.id;
  for (const instruction of sequence.setup_cue.instructions) {
    await trackInstructionValues(
      tracked,
      instruction,
      {
        label: "Setup",
        cueUid: sequence.setup_cue.identifiers.uid,
        sequenceId,
        sequenceUid: sequence.identifiers.uid,
        partId: 0,
        setupSequenceUid: sequence.identifiers.uid,
      },
      blueprintMap,
    );
  }

  for (const cueUid of sequence.steps.slice(0, targetIndex)) {
    const cue = cueMap[cueUid];
    if (!cue) continue;
    const source = {
      label: formatCueEditorTitle({
        cueId: cue.identifiers.id,
        sequenceId,
        partId: 0,
        hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
      }),
      cueUid: cue.identifiers.uid,
      cueId: cue.identifiers.id,
      sequenceId,
      sequenceUid: sequence.identifiers.uid,
      partId: 0,
      hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
    };
    for (const instruction of cue.instructions) {
      await trackInstructionValues(tracked, instruction, source, blueprintMap);
    }
    for (const part of cue.parts ?? []) {
      const partSource = {
        ...source,
        label: formatCueEditorTitle({
          cueId: cue.identifiers.id,
          sequenceId,
          partId: part.identifiers.id,
          hasAdditionalParts: true,
        }),
        partId: part.identifiers.id,
      };
      for (const instruction of part.instructions) {
        await trackInstructionValues(
          tracked,
          instruction,
          partSource,
          blueprintMap,
        );
      }
    }
  }

  return tracked;
}

/** Builds a WASM lookahead projection instruction from one cue instruction. */
export async function lookaheadProjectionInstruction(
  instruction: types.BoundCueInstruction,
): Promise<LookaheadProjectionInstruction> {
  return {
    fixtures: await resolvedFixtureRefsForSelection(instruction.selection),
    values: instruction.cue_instruction.values,
  };
}

/** Builds a WASM lookahead projection cue from one sequence cue definition. */
export async function lookaheadProjectionCue(
  cue: types.Cue,
): Promise<LookaheadProjectionCue> {
  return {
    cue_uid: cue.identifiers.uid,
    cue_id: cue.identifiers.id,
    lookahead: cue.lookahead === true,
    instructions: await Promise.all(
      cue.instructions.map(lookaheadProjectionInstruction),
    ),
    parts: await Promise.all(
      (cue.parts ?? []).map(async (part) => ({
        part_id: part.identifiers.id,
        lookahead: part.lookahead === true,
        instructions: await Promise.all(
          part.instructions.map(lookaheadProjectionInstruction),
        ),
      })),
    ),
  };
}

/** Converts one WASM projected lookahead source into cue-grid source metadata. */
export function projectedLookaheadSource(
  value: ProjectedLookaheadValue,
): TrackedCueSource {
  return {
    label: formatCueEditorTitle({
      cueId: value.source.cue_id,
      sequenceId: value.source.sequence_id,
      partId: value.source.part_id,
      hasAdditionalParts: value.source.has_additional_parts,
    }),
    cueUid: value.source.cue_uid,
    cueId: value.source.cue_id,
    sequenceId: value.source.sequence_id,
    partId: value.source.part_id,
    hasAdditionalParts: value.source.has_additional_parts,
  };
}

/** Computes display-only lookahead values with the shared Rust/WASM evaluator. */
export async function authoredLookaheadValuesForCue(
  sequence: types.Sequence | undefined,
  cueMap: Record<string, types.Cue>,
  targetCue: types.Cue,
): Promise<LookaheadCueValues> {
  const lookahead: LookaheadCueValues = new Map();
  if (!sequence || targetCue.identifiers.id === 0) {
    return lookahead;
  }

  const cues = (
    await Promise.all(
      sequence.steps.map(async (cueUid) => {
        const cue = cueMap[cueUid];
        return cue ? lookaheadProjectionCue(cue) : undefined;
      }),
    )
  ).filter((cue): cue is LookaheadProjectionCue => cue !== undefined);

  const projectedValues = await projectSequenceLookahead({
    sequence_id: sequence.identifiers.id,
    wrap: sequence.wrap,
    target_cue_uid: targetCue.identifiers.uid,
    setup_instructions: await Promise.all(
      sequence.setup_cue.instructions.map(lookaheadProjectionInstruction),
    ),
    cues,
  });
  for (const value of projectedValues ?? []) {
    lookahead.set(trackedCueValueKey(value.fixture, value.attribute), {
      value: value.value,
      source: projectedLookaheadSource(value),
    });
  }

  return lookahead;
}

/** Returns whether a layer stack entry belongs to the requested sequence cue. */
export function layerBelongsToSequenceCue(
  layer: types.OutboundLayerState,
  sequence: types.Sequence,
  targetCue: types.Cue,
): boolean {
  const objectRef = layer.object_ref;
  if (
    !(
      objectRef?.type === "ByUid" &&
      objectRef.data.object_type === ObjectType.Sequence &&
      objectRef.data.uid === sequence.identifiers.uid
    )
  ) {
    return false;
  }

  const position = layer.runtime_position;
  return (
    position?.type === "Sequence" &&
    position.data.current_cue_uid === targetCue.identifiers.uid
  );
}

/** Builds the source metadata used for backend-projected lookahead values. */
export function lookaheadSourceForCue(
  sequence: types.Sequence,
  targetCue: types.Cue,
): TrackedCueSource {
  return {
    label: `lookahead for sequence ${sequence.identifiers.id}`,
    cueUid: targetCue.identifiers.uid,
    cueId: targetCue.identifiers.id,
    sequenceId: sequence.identifiers.id,
    sequenceUid: sequence.identifiers.uid,
    partId: 0,
    hasAdditionalParts: (targetCue.parts?.length ?? 0) > 0,
  };
}

/** Converts backend layer-stack lookahead assertions into cue-grid Lookahead values. */
export function backendLookaheadValuesForCue(
  sequence: types.Sequence | undefined,
  targetCue: types.Cue,
  layers: readonly types.OutboundLayerState[],
): LookaheadCueValues {
  const lookahead: LookaheadCueValues = new Map();
  if (!sequence) return lookahead;

  const source = lookaheadSourceForCue(sequence, targetCue);
  for (const layer of layers) {
    if (!layerBelongsToSequenceCue(layer, sequence, targetCue)) continue;
    for (const row of layer.lookahead_asserted_values) {
      row.parameters.forEach((parameters, elementIndex) => {
        for (const [attr, value] of Object.entries(parameters)) {
          if (!isLookaheadPositionAttribute(attr)) continue;
          if (!isAbsoluteParameterValue(value)) continue;

          const indexedRef = {
            fixture_uid: row.fixture_uid,
            index: elementIndex + 1,
          };
          lookahead.set(trackedCueValueKey(indexedRef, attr), {
            value,
            source,
          });

          if (elementIndex === 0) {
            lookahead.set(
              trackedCueValueKey({ fixture_uid: row.fixture_uid }, attr),
              { value, source },
            );
          }
        }
      });
    }
  }

  return lookahead;
}

/** Computes lookahead values, preferring backend playback projections when available. */
export async function lookaheadValuesForCue(
  sequence: types.Sequence | undefined,
  cueMap: Record<string, types.Cue>,
  targetCue: types.Cue,
  layers: readonly types.OutboundLayerState[],
): Promise<LookaheadCueValues> {
  const backendValues = backendLookaheadValuesForCue(
    sequence,
    targetCue,
    layers,
  );
  if (backendValues.size > 0) return backendValues;
  return authoredLookaheadValuesForCue(sequence, cueMap, targetCue);
}

/** Returns the processed tracked value for one fixture attribute. */
export function processedTrackedValue(
  fixtureRef: types.FixtureRef,
  attr: string,
  tracked: TrackedCueValues,
): ProcessedParameterValue | undefined {
  const trackedEntry = tracked.get(trackedCueValueKey(fixtureRef, attr));
  if (
    trackedEntry === undefined ||
    trackedEntry.value === TRACKED_VALUE_CLEARED
  ) {
    return undefined;
  }
  return (
    parameterValueToProcessedParameterValue(trackedEntry.value) ?? undefined
  );
}

/** Returns the source cue for a directly tracked fixture attribute. */
export function directTrackedSource(
  fixtureRef: types.FixtureRef,
  attr: string,
  tracked: TrackedCueValues,
): TrackedCueSource | undefined {
  const trackedEntry = tracked.get(trackedCueValueKey(fixtureRef, attr));
  if (!trackedEntry || trackedEntry.value === TRACKED_VALUE_CLEARED) {
    return undefined;
  }
  return trackedEntry.source;
}

/** Returns whether two processed values can share one parent fixture display. */
export function processedValuesMatch(
  left: ProcessedParameterValue,
  right: ProcessedParameterValue,
): boolean {
  return (
    left.value === right.value &&
    left.isPercentage === right.isPercentage &&
    left.isRelative === right.isRelative
  );
}

/** Returns the shared effective tracked value for a collapsed parent row. */
export function sharedElementTrackedValue(
  fixture: types.Fixture,
  attr: string,
  tracked: TrackedCueValues,
): ProcessedParameterValue | undefined {
  const fixtureValue = processedTrackedValue(
    { fixture_uid: fixture.identifiers.uid },
    attr,
    tracked,
  );
  let sharedValue: ProcessedParameterValue | undefined;
  for (const [index] of fixture.elements.entries()) {
    const elementIndex = index + 1;
    if (!getFixtureElementAttributeNames(fixture, elementIndex).has(attr)) {
      continue;
    }

    const elementTrackedEntry = tracked.get(
      trackedCueValueKey(
        { fixture_uid: fixture.identifiers.uid, index: elementIndex },
        attr,
      ),
    );
    if (elementTrackedEntry?.value === TRACKED_VALUE_CLEARED) return undefined;
    const elementValue =
      elementTrackedEntry === undefined
        ? fixtureValue
        : (parameterValueToProcessedParameterValue(elementTrackedEntry.value) ??
          undefined);
    if (!elementValue) return undefined;
    if (!sharedValue) {
      sharedValue = elementValue;
      continue;
    }
    if (!processedValuesMatch(sharedValue, elementValue)) return undefined;
  }
  return sharedValue;
}

/** Returns the common source for collapsed element tracked values, when unambiguous. */
export function sharedElementTrackedSource(
  fixture: types.Fixture,
  attr: string,
  tracked: TrackedCueValues,
): TrackedCueSource | undefined {
  const fixtureSource = directTrackedSource(
    { fixture_uid: fixture.identifiers.uid },
    attr,
    tracked,
  );
  let sharedSource: TrackedCueSource | undefined;
  let hasApplicableElement = false;
  for (const [index] of fixture.elements.entries()) {
    const elementIndex = index + 1;
    if (!getFixtureElementAttributeNames(fixture, elementIndex).has(attr)) {
      continue;
    }
    hasApplicableElement = true;

    const elementEntry = tracked.get(
      trackedCueValueKey(
        { fixture_uid: fixture.identifiers.uid, index: elementIndex },
        attr,
      ),
    );
    if (elementEntry?.value === TRACKED_VALUE_CLEARED) return undefined;
    const source = elementEntry?.source ?? fixtureSource;
    if (!source) return undefined;
    if (!sharedSource) {
      sharedSource = source;
      continue;
    }
    if (
      sharedSource.cueUid !== source.cueUid ||
      sharedSource.sequenceId !== source.sequenceId ||
      sharedSource.partId !== source.partId ||
      sharedSource.setupSequenceUid !== source.setupSequenceUid
    ) {
      return undefined;
    }
  }
  if (!hasApplicableElement) return fixtureSource;
  return sharedSource;
}

/** Converts tracked fixture values into displayable attributes for one row. */
export function trackedAttributesForFixture(
  fixtureRef: types.FixtureRef,
  applicableAttributes: ReadonlySet<string>,
  tracked: TrackedCueValues,
  fixture?: types.Fixture,
): Record<string, ProcessedParameterValue> {
  const attributes: Record<string, ProcessedParameterValue> = {};
  for (const attr of applicableAttributes) {
    if (
      isWholeFixtureRef(fixtureRef) &&
      fixture &&
      fixture.elements.length > 0
    ) {
      const sharedValue = sharedElementTrackedValue(fixture, attr, tracked);
      if (sharedValue) attributes[attr] = sharedValue;
      continue;
    }

    const processedValue = processedTrackedValue(fixtureRef, attr, tracked);
    if (processedValue) attributes[attr] = processedValue;
  }
  return attributes;
}

/** Converts tracked fixture values into source cues for one row. */
export function trackedSourcesForFixture(
  fixtureRef: types.FixtureRef,
  trackedAttributes: Record<string, ProcessedParameterValue>,
  tracked: TrackedCueValues,
  fixture?: types.Fixture,
): Record<string, TrackedCueSource> {
  const sources: Record<string, TrackedCueSource> = {};
  for (const attr of Object.keys(trackedAttributes)) {
    const source =
      isWholeFixtureRef(fixtureRef) && fixture && fixture.elements.length > 0
        ? sharedElementTrackedSource(fixture, attr, tracked)
        : directTrackedSource(fixtureRef, attr, tracked);
    if (source) sources[attr] = source;
  }
  return sources;
}

/** Returns whether an attribute can be pre-positioned by lookahead. */
export function isLookaheadPositionAttribute(attr: string): boolean {
  const normalized = normalizeAttributeName(attr);
  return normalized === "Pan" || normalized === "Tilt";
}

/** Returns whether a concrete parameter value is an absolute assertion. */
export function isAbsoluteParameterValue(value: types.ParameterValue): boolean {
  return value.type === "Absolute" || value.type === "AbsolutePercent";
}

/** Resolves a displayable lookahead value for one fixture attribute. */
export function processedLookaheadValue(
  fixtureRef: types.FixtureRef,
  attr: string,
  lookahead: LookaheadCueValues,
): ProcessedParameterValue | undefined {
  const entry = lookahead.get(trackedCueValueKey(fixtureRef, attr));
  return entry
    ? (parameterValueToProcessedParameterValue(entry.value) ?? undefined)
    : undefined;
}

/** Returns the source cue for a lookahead fixture attribute. */
export function directLookahead(
  fixtureRef: types.FixtureRef,
  attr: string,
  lookahead: LookaheadCueValues,
): TrackedCueSource | undefined {
  return lookahead.get(trackedCueValueKey(fixtureRef, attr))?.source;
}

/** Converts lookahead values into displayable attributes for one row. */
export function lookaheadAttributesForFixture(
  fixtureRef: types.FixtureRef,
  applicableAttributes: ReadonlySet<string>,
  lookahead: LookaheadCueValues,
): Record<string, ProcessedParameterValue> {
  const attributes: Record<string, ProcessedParameterValue> = {};
  for (const attr of applicableAttributes) {
    const processedValue = processedLookaheadValue(fixtureRef, attr, lookahead);
    if (processedValue) attributes[attr] = processedValue;
  }
  return attributes;
}

/** Converts lookahead values into source cues for one row. */
export function lookaheadSourcesForFixture(
  fixtureRef: types.FixtureRef,
  lookaheadAttributes: Record<string, ProcessedParameterValue>,
  lookahead: LookaheadCueValues,
): Record<string, TrackedCueSource> {
  const sources: Record<string, TrackedCueSource> = {};
  for (const attr of Object.keys(lookaheadAttributes)) {
    const source = directLookahead(fixtureRef, attr, lookahead);
    if (source) sources[attr] = source;
  }
  return sources;
}

/** Returns whether one processed grid value equals the tracked source value. */
export function processedValueMatchesTracked(
  value: ProcessedParameterValue,
  trackedEntry: TrackedCueEntry | undefined,
): boolean {
  if (
    trackedEntry === undefined ||
    trackedEntry.value === TRACKED_VALUE_CLEARED ||
    value.value === undefined
  ) {
    return false;
  }
  const trackedResult = parameterValueToProcessedParameterValue(
    trackedEntry.value,
  );
  if (!trackedResult) return false;
  return (
    trackedResult.value === value.value &&
    trackedResult.isPercentage === value.isPercentage &&
    trackedResult.isRelative === value.isRelative
  );
}

/** Returns whether a whole-fixture value matches all tracked element values. */
export function processedValueMatchesTrackedFixtureElements(
  value: ProcessedParameterValue,
  fixture: types.Fixture,
  attr: string,
  tracked: TrackedCueValues,
): boolean | undefined {
  if (fixture.elements.length === 0) return undefined;
  const fixtureTrackedEntry = tracked.get(
    trackedCueValueKey({ fixture_uid: fixture.identifiers.uid }, attr),
  );
  let hasApplicableElement = false;
  for (const [index] of fixture.elements.entries()) {
    const elementIndex = index + 1;
    if (!getFixtureElementAttributeNames(fixture, elementIndex).has(attr)) {
      continue;
    }
    hasApplicableElement = true;
    const trackedEntry = tracked.get(
      trackedCueValueKey(
        { fixture_uid: fixture.identifiers.uid, index: elementIndex },
        attr,
      ),
    );
    if (trackedEntry?.value === TRACKED_VALUE_CLEARED) return false;
    if (
      !processedValueMatchesTracked(
        value,
        trackedEntry === undefined ? fixtureTrackedEntry : trackedEntry,
      )
    ) {
      return false;
    }
  }
  return hasApplicableElement ? true : undefined;
}

/** Returns whether one displayed value should be marked as blocked. */
export function valueMatchesTrackedBlock(
  value: ProcessedParameterValue,
  fixtureRef: types.FixtureRef,
  attr: string,
  tracked: TrackedCueValues,
  fixture?: types.Fixture,
): boolean {
  if (
    processedValueMatchesTracked(
      value,
      tracked.get(trackedCueValueKey(fixtureRef, attr)),
    )
  ) {
    return true;
  }
  if (isWholeFixtureRef(fixtureRef) && fixture && fixture.elements.length > 0) {
    const elementMatch = processedValueMatchesTrackedFixtureElements(
      value,
      fixture,
      attr,
      tracked,
    );
    if (elementMatch !== undefined) return elementMatch;
  }
  return false;
}

/** Adds display-only block labels for values equal to the tracked-in value. */
export function attributesWithTrackedBlockMarkers(
  attributes: CueFixtureRowBase["attributes"],
  fixtureRef: types.FixtureRef,
  tracked: TrackedCueValues,
  fixture?: types.Fixture,
): CueFixtureRowBase["attributes"] {
  const mark = (
    values: Record<string, ProcessedParameterValue>,
  ): Record<string, ProcessedParameterValue> =>
    Object.fromEntries(
      Object.entries(values).map(([attr, value]) => {
        return [
          attr,
          valueMatchesTrackedBlock(value, fixtureRef, attr, tracked, fixture)
            ? { ...value, marker: "block" as const }
            : { ...value },
        ];
      }),
    );

  return {
    abs: mark(attributes.abs),
    rel: mark(attributes.rel),
    release: attributes.release,
  };
}

/** Resolves the cue attribute represented by a grid column. */
export function attributeForGridColumn(
  column: GridColumn | undefined,
): string | undefined {
  if (!column) return undefined;
  const cueColumn = column as CueGridColumn;
  if (cueColumn.cueAttribute) return cueColumn.cueAttribute;
  if (column.group) return normalizeAttributeName(column.group);
  const columnId = column.id ?? "";
  return (
    parseValueColumnId(columnId)?.attr ?? parseTimingColumnId(columnId)?.attr
  );
}

/** Resolves the cue timing field represented by a grid column. */
export function timingColumnForGridColumn(
  column: GridColumn | undefined,
): { attr: string; field: TimingField } | undefined {
  if (!column) return undefined;
  const cueColumn = column as CueGridColumn;
  if (cueColumn.cueAttribute && cueColumn.cueTimingField) {
    return { attr: cueColumn.cueAttribute, field: cueColumn.cueTimingField };
  }
  const columnId = column.id ?? "";
  return parseTimingColumnId(columnId);
}

/** Deletes record entries whose keys match an attribute after normalization. */
export function deleteNormalizedAttributeKeys(
  record: Record<string, unknown> | undefined,
  attr: string,
): boolean {
  if (!record) return false;
  let changed = false;
  for (const key of Object.keys(record)) {
    if (key !== attr && normalizeAttributeName(key) !== attr) continue;
    delete record[key];
    changed = true;
  }
  return changed;
}

/** Resolves the stored record key for an attribute after normalization. */
export function normalizedAttributeKey(
  record: Record<string, unknown> | undefined,
  attr: string,
): string | undefined {
  if (!record) return undefined;
  return Object.keys(record).find(
    (key) => key === attr || normalizeAttributeName(key) === attr,
  );
}

/** Deletes only asserted values for an attribute while preserving timing metadata. */
export function deleteInstructionAttributeValues(
  instruction: types.CueInstruction,
  attr: string,
): boolean {
  return deleteNormalizedAttributeKeys(instruction.values, attr);
}

/** Returns whether a cue instruction still asserts any attribute values. */
export function instructionHasValueAssertions(
  instruction: types.CueInstruction,
): boolean {
  return Object.keys(instruction.values ?? {}).length > 0;
}

/** Returns whether a cue instruction still carries timing metadata. */
export function instructionHasTimingMetadata(
  instruction: types.CueInstruction,
): boolean {
  if (Object.keys(instruction.transitions_by_attribute ?? {}).length > 0) {
    return true;
  }
  return (
    instruction.transitions_by_fixture_attribute?.some(
      (entry) => Object.keys(entry.transitions_by_attribute).length > 0,
    ) ?? false
  );
}

/** Removes bound cue instructions that no longer assert values or carry timing. */
export function pruneEmptyAssertionInstructions(
  instructions: types.BoundCueInstruction[],
): boolean {
  let changed = false;
  for (let index = instructions.length - 1; index >= 0; index--) {
    const instruction = instructions[index].cue_instruction;
    if (
      instructionHasValueAssertions(instruction) ||
      instructionHasTimingMetadata(instruction)
    ) {
      continue;
    }
    instructions.splice(index, 1);
    changed = true;
  }
  return changed;
}

/** Deletes asserted values and timing metadata for one instruction attribute. */
export function deleteInstructionAttribute(
  instruction: types.CueInstruction,
  attr: string,
): boolean {
  let changed = deleteInstructionAttributeValues(instruction, attr);
  changed =
    deleteNormalizedAttributeKeys(instruction.transitions_by_attribute, attr) ||
    changed;

  const fixtureTransitions = instruction.transitions_by_fixture_attribute;
  if (fixtureTransitions) {
    for (const entry of fixtureTransitions) {
      changed =
        deleteNormalizedAttributeKeys(entry.transitions_by_attribute, attr) ||
        changed;
    }
    instruction.transitions_by_fixture_attribute = fixtureTransitions.filter(
      (entry) => Object.keys(entry.transitions_by_attribute).length > 0,
    );
  }

  return changed;
}

/** Returns the instruction list for the active cue editor part. */
export function instructionContainerForPart(
  cue: types.Cue,
  partId: number,
): types.BoundCueInstruction[] | undefined {
  if (partId === 0) return cue.instructions;
  return cue.parts?.find((part) => part.identifiers.id === partId)
    ?.instructions;
}

/** Checks whether any instruction in the active part writes the attribute. */
export function instructionContainerHasAttribute(
  instructions: readonly types.BoundCueInstruction[] | undefined,
  attr: string,
): boolean {
  return (
    instructions?.some(({ cue_instruction: instruction }) =>
      Object.keys(instruction.values ?? {}).some(
        (key) => key === attr || normalizeAttributeName(key) === attr,
      ),
    ) ?? false
  );
}

/** Resolves a cue instruction selection to unique fixture definitions in display order. */
export function fixturesForResolvedRefs(
  resolved: readonly types.FixtureRef[],
  allFixtures: types.Fixture[],
): types.Fixture[] {
  const fixturesByUid = new Map(
    allFixtures.map((fixture) => [fixture.identifiers.uid, fixture]),
  );
  const seenFixtureUids = new Set<string>();
  const fixtures: types.Fixture[] = [];

  for (const ref of resolved) {
    if (seenFixtureUids.has(ref.fixture_uid)) continue;
    const fixture = fixturesByUid.get(ref.fixture_uid);
    if (!fixture) continue;
    fixtures.push(fixture);
    seenFixtureUids.add(ref.fixture_uid);
  }

  return fixtures;
}

/** Returns whether one instruction row targets exactly the supplied fixture ref. */
export function instructionTargetsFixtureRef(
  instruction: types.BoundCueInstruction | undefined,
  fixtureRef: types.FixtureRef,
): boolean {
  const instructionRef = instruction
    ? singleResolvedInstructionFixtureRef(instruction)
    : undefined;
  return instructionRef
    ? fixtureRefKey(instructionRef) === fixtureRefKey(fixtureRef)
    : false;
}

/** Returns an instruction item suitable for editing one exact fixture ref. */
export function instructionForFixtureRefEdit(
  instructions: types.BoundCueInstruction[] | undefined,
  selectionIndex: number,
  fixtureRef: types.FixtureRef,
  options: { create: boolean },
): types.BoundCueInstruction | undefined {
  if (!instructions) return undefined;

  const indexedInstruction = instructions[selectionIndex];
  if (instructionTargetsFixtureRef(indexedInstruction, fixtureRef)) {
    return indexedInstruction;
  }

  return options.create
    ? ensureInstructionForFixtureRef(instructions, fixtureRef)
    : findInstructionForFixtureRef(instructions, fixtureRef);
}

/** Returns whether a resolved instruction explicitly targets the whole fixture row. */
export function instructionSelectsWholeFixtureRef(
  refs: readonly types.FixtureRef[],
  fixtureUid: string,
): boolean {
  return refs.some(
    (ref) =>
      sameFixtureUid(ref.fixture_uid, fixtureUid) && isWholeFixtureRef(ref),
  );
}

/** Builds the expansion key shared by grouped element-only rows. */
export function groupedElementExpansionKey(
  partIndex: number | undefined,
  displayMode: DisplayMode,
  fixtureUid: string,
): string {
  return `${partIndex === undefined ? "parent" : partIndex}:${displayMode}:${fixtureUid}`;
}

/** Returns whether a fixture row should be merged with sibling element-only rows. */
export function shouldGroupElementOnlyFixtureRow(
  row: CueParentRow,
  instructionSelectsWholeFixture: boolean,
): boolean {
  return row.selectedElementRows.length > 0 && !instructionSelectsWholeFixture;
}

/** Appends one visible fixture row, grouping element-only rows under one parent. */
export function appendVisibleFixtureRow(
  flatRows: CueFixtureRow[],
  groupedElementParentRows: Map<string, CueParentRow>,
  fixtureRow: CueParentRow,
  options: {
    displayMode: DisplayMode;
    expandedFixtures: ReadonlySet<string>;
    includeElementRows: boolean;
    instructionSelectsWholeFixture: boolean;
  },
): void {
  const shouldGroupElementRows = shouldGroupElementOnlyFixtureRow(
    fixtureRow,
    options.instructionSelectsWholeFixture,
  );
  const elementGroupExpansionKey = groupedElementExpansionKey(
    fixtureRow.partIndex,
    options.displayMode,
    fixtureRow.fixtureUid,
  );
  if (shouldGroupElementRows) {
    fixtureRow.expansionKey = elementGroupExpansionKey;
    fixtureRow.isExpanded = options.expandedFixtures.has(
      elementGroupExpansionKey,
    );
    for (const elementRow of fixtureRow.selectedElementRows) {
      elementRow.expansionKey = elementGroupExpansionKey;
    }
    fixtureRow.instructionTargets = fixtureRow.selectedElementRows.flatMap(
      (elementRow) => elementRow.instructionTargets,
    );
  }
  const visibleFixtureRow = shouldGroupElementRows
    ? (groupedElementParentRows.get(elementGroupExpansionKey) ?? fixtureRow)
    : fixtureRow;

  if (shouldGroupElementRows) {
    if (!groupedElementParentRows.has(elementGroupExpansionKey)) {
      groupedElementParentRows.set(elementGroupExpansionKey, visibleFixtureRow);
      flatRows.push(visibleFixtureRow);
    } else {
      visibleFixtureRow.selectedElementRows.push(
        ...fixtureRow.selectedElementRows,
      );
      visibleFixtureRow.instructionTargets.push(
        ...fixtureRow.instructionTargets,
      );
      visibleFixtureRow.selectionIndex = Math.min(
        visibleFixtureRow.selectionIndex,
        fixtureRow.selectionIndex,
      );
    }
  } else {
    flatRows.push(visibleFixtureRow);
  }

  if (options.includeElementRows && visibleFixtureRow.isExpanded) {
    flatRows.push(...fixtureRow.selectedElementRows);
  }
}

/** Maps selected fixture elements to the fanned timing offset used by materialization. */
export async function selectionTimingPositionsForFixtureElements(
  selection: types.SpatialSelection,
  fixture: types.Fixture,
): Promise<Map<number, SelectionTimingPosition>> {
  const resolvedIndexes = await resolvedSelectionTimingIndexes(selection);
  const positions = new Map<number, SelectionTimingPosition>();
  const total = Math.max(1, resolvedIndexes.length);

  for (const [offset, index] of resolvedIndexes.entries()) {
    for (const ref of index.members) {
      if (!sameFixtureUid(ref.fixture_uid, fixture.identifiers.uid)) continue;

      if (ref.index === null || ref.index === undefined) {
        for (
          let elementIndex = 1;
          elementIndex <= fixture.elements.length;
          elementIndex++
        ) {
          if (!positions.has(elementIndex)) {
            positions.set(elementIndex, { offset, total });
          }
        }
        continue;
      }

      if (
        ref.index >= 1 &&
        ref.index <= fixture.elements.length &&
        !positions.has(ref.index)
      ) {
        positions.set(ref.index, { offset, total });
      }
    }
  }

  return positions;
}

/** Resolves all timing fields for the supplied attributes at a selection position. */
export async function buildTransitionValues(
  resolver: TransitionModeResolver,
  cue: types.Cue,
  instruction: types.CueInstruction,
  attrs: string[],
  timingPosition: SelectionTimingPosition,
  fixtureRef: types.FixtureRef,
): Promise<CueFixtureRow["transitions"]> {
  const attrEntries = await Promise.all(
    attrs.map(async (attr) => {
      const fieldEntries = await Promise.all(
        TIMING_COLUMNS.map(async ({ field }) => [
          field,
          await resolveCueInstructionTiming(
            resolver,
            cue,
            instruction,
            attr,
            field,
            timingPosition.offset,
            timingPosition.total,
            fixtureRef,
          ),
        ]),
      );
      return [attr, Object.fromEntries(fieldEntries)];
    }),
  );
  return Object.fromEntries(attrEntries);
}

/** Returns every attribute that should have timing cells for an instruction. */
export function timingAttributesForInstruction(
  instruction: types.CueInstruction,
): string[] {
  const attrs = new Set<string>();
  for (const attr of Object.keys(instruction.values ?? {})) {
    attrs.add(normalizeAttributeName(attr));
  }
  for (const attr of Object.keys(instruction.transitions_by_attribute ?? {})) {
    attrs.add(normalizeAttributeName(attr));
  }
  for (const fixtureTiming of instruction.transitions_by_fixture_attribute ??
    []) {
    for (const attr of Object.keys(fixtureTiming.transitions_by_attribute)) {
      attrs.add(normalizeAttributeName(attr));
    }
  }
  return sortedAttributes([...attrs]);
}

/** Resolves fixture-level timing cells using the fixture's materialization position. */
export async function buildFixtureTransitionValues(
  resolver: TransitionModeResolver,
  cue: types.Cue,
  instructionItem: types.BoundCueInstruction,
  fixturesByUid: ReadonlyMap<string, types.Fixture>,
  fixtureUid: string,
  attrs: string[],
): Promise<CueFixtureRow["transitions"]> {
  const fixtureRef: types.FixtureRef = { fixture_uid: fixtureUid };
  const entries = await Promise.all(
    attrs.map(async (attr) => {
      const timingPosition = await selectionTimingPositionForFixtureAttribute(
        instructionItem.selection,
        fixturesByUid,
        fixtureUid,
        attr,
      );
      return [
        attr,
        (
          await buildTransitionValues(
            resolver,
            cue,
            instructionItem.cue_instruction,
            [attr],
            timingPosition,
            fixtureRef,
          )
        )[attr],
      ];
    }),
  );
  return Object.fromEntries(entries);
}

/** Converts cue instructions and active part state into visible grid rows. */
export async function processCueInstructions(
  cue: types.Cue,
  allFixtures: types.Fixture[],
  partId: number,
  expandedFixtures: ReadonlySet<string>,
  displayMode: DisplayMode,
  includeElementRows: boolean,
  includeTrackedRows: boolean,
  trackedValues: TrackedCueValues,
  lookaheadValues: LookaheadCueValues,
  blueprintMap: Record<string, types.Blueprint> = {},
): Promise<ProcessedCueData> {
  const flatRows: CueFixtureRow[] = [];
  const conflictRows: CueFixtureRow[] = [];
  const groupedElementParentRows = new Map<string, CueParentRow>();
  const visibleParentFixtureUids = new Set<string>();
  const fixturesByUid = new Map(
    allFixtures.map((fixture) => [fixture.identifiers.uid, fixture]),
  );
  const transitionResolver = createTransitionModeResolver();

  /** Appends instruction rows for the parent cue or one cue part. */
  const processInstructions = async (
    instructions: types.BoundCueInstruction[],
    partIndex?: number,
    partLabel?: string,
    visible = true,
  ) => {
    for (const [selectionIndex, item] of instructions.entries()) {
      const resolvedInstruction: types.CueInstruction = {
        ...item.cue_instruction,
        values: resolvedBlueprintInstructionValues(
          item.cue_instruction,
          blueprintMap,
        ),
      };
      const blueprintSource = blueprintValueSourceForInstruction(
        item.cue_instruction,
        blueprintMap,
      );
      const sourceLabel = partLabel ?? "Parent";
      const resolvedFixtureRefs = await resolvedFixtureRefsForSelection(
        item.selection,
      );
      const matchedFixtures = fixturesForResolvedRefs(
        resolvedFixtureRefs,
        allFixtures,
      );
      const transitionAttrs =
        timingAttributesForInstruction(resolvedInstruction);

      for (const fixture of matchedFixtures) {
        const instructionSelectsWholeFixture =
          instructionSelectsWholeFixtureRef(
            resolvedFixtureRefs,
            fixture.identifiers.uid,
          );
        const fixtureElementTimingPositions =
          await selectionTimingPositionsForFixtureElements(
            item.selection,
            fixture,
          );
        const selectedElementRows: CueElementRow[] = [];
        const expansionKey = `${
          partIndex === undefined ? "parent" : partIndex
        }:${selectionIndex}:${fixture.identifiers.uid}`;
        const isExpanded = expandedFixtures.has(expansionKey);
        const singleElementTimingPosition =
          fixture.elements.length === 1 && !instructionSelectsWholeFixture
            ? fixtureElementTimingPositions.get(1)
            : undefined;
        const parentFixtureRef: types.FixtureRef = {
          fixture_uid: fixture.identifiers.uid,
          ...(singleElementTimingPosition ? { index: 1 } : {}),
        };
        const parentAttributes = applyBlueprintValueSource(
          projectCueInstructionValuesForFixtureRef(
            resolvedInstruction.values,
            resolvedFixtureRefs,
            parentFixtureRef,
          ),
          blueprintSource,
        );
        const parentApplicableAttributes = getFixtureAttributeNames(fixture);

        if (includeElementRows && fixture.elements.length > 1) {
          for (const [elementIndex, timingPosition] of [
            ...fixtureElementTimingPositions.entries(),
          ].sort(([a], [b]) => a - b)) {
            const element = fixture.elements[elementIndex - 1];
            if (!element) continue;
            const elementFixtureRef = {
              fixture_uid: fixture.identifiers.uid,
              index: elementIndex,
            };
            const elementApplicableAttributes = getFixtureElementAttributeNames(
              fixture,
              elementIndex,
            );
            const elementAttributes = applyBlueprintValueSource(
              projectCueInstructionValuesForFixtureRef(
                resolvedInstruction.values,
                resolvedFixtureRefs,
                elementFixtureRef,
              ),
              blueprintSource,
            );
            const elementTrackedAttributes = trackedAttributesForFixture(
              elementFixtureRef,
              elementApplicableAttributes,
              trackedValues,
            );
            const elementLookaheadAttributes = lookaheadAttributesForFixture(
              elementFixtureRef,
              elementApplicableAttributes,
              lookaheadValues,
            );
            selectedElementRows.push({
              type: "element",
              uid: `${fixture.identifiers.uid}:${
                partIndex === undefined ? "parent" : partIndex
              }:${selectionIndex}:${elementIndex}`,
              fixtureUid: fixture.identifiers.uid,
              id: fixture.identifiers.id,
              sourceLabel,
              label: element.label,
              selectionIndex,
              instructionTargets: [
                {
                  partIndex,
                  selectionIndex,
                  fixtureRef: elementFixtureRef,
                },
              ],
              partIndex,
              partLabel,
              elementIndex,
              fixtureRef: elementFixtureRef,
              expansionKey,
              applicableAttributes: elementApplicableAttributes,
              attributes: attributesWithTrackedBlockMarkers(
                elementAttributes,
                elementFixtureRef,
                trackedValues,
              ),
              trackedAttributes: elementTrackedAttributes,
              trackedAttributeSources: trackedSourcesForFixture(
                elementFixtureRef,
                elementTrackedAttributes,
                trackedValues,
              ),
              lookaheadAttributes: elementLookaheadAttributes,
              lookaheadAttributeSources: lookaheadSourcesForFixture(
                elementFixtureRef,
                elementLookaheadAttributes,
                lookaheadValues,
              ),
              conflictingValues: new Set<string>(),
              valueConflicts: new Map<string, CueValueConflict>(),
              colorPathId: resolvedInstruction.color_path_id,
              transitions: await buildTransitionValues(
                transitionResolver,
                cue,
                resolvedInstruction,
                transitionAttrs,
                timingPosition,
                {
                  fixture_uid: fixture.identifiers.uid,
                  index: elementIndex,
                },
              ),
            });
          }
        }

        const parentTrackedAttributes = trackedAttributesForFixture(
          parentFixtureRef,
          parentApplicableAttributes,
          trackedValues,
          fixture,
        );
        const parentLookaheadAttributes = lookaheadAttributesForFixture(
          parentFixtureRef,
          parentApplicableAttributes,
          lookaheadValues,
        );
        const fixtureRow: CueParentRow = {
          type: "parent",
          uid: `${fixture.identifiers.uid}:${
            partIndex === undefined ? "parent" : partIndex
          }:${selectionIndex}`,
          fixtureUid: fixture.identifiers.uid,
          id: fixture.identifiers.id,
          sourceLabel,
          label: fixture.identifiers.label,
          selectionIndex,
          instructionTargets: [
            {
              partIndex,
              selectionIndex,
              fixtureRef: parentFixtureRef,
            },
          ],
          partIndex,
          partLabel,
          fixtureRef: parentFixtureRef,
          expansionKey,
          hasElements: selectedElementRows.length > 0,
          isExpanded,
          selectedElementRows,
          applicableAttributes: parentApplicableAttributes,
          attributes: attributesWithTrackedBlockMarkers(
            parentAttributes,
            parentFixtureRef,
            trackedValues,
            fixture,
          ),
          trackedAttributes: parentTrackedAttributes,
          trackedAttributeSources: trackedSourcesForFixture(
            parentFixtureRef,
            parentTrackedAttributes,
            trackedValues,
            fixture,
          ),
          lookaheadAttributes: parentLookaheadAttributes,
          lookaheadAttributeSources: lookaheadSourcesForFixture(
            parentFixtureRef,
            parentLookaheadAttributes,
            lookaheadValues,
          ),
          conflictingValues: new Set<string>(),
          valueConflicts: new Map<string, CueValueConflict>(),
          colorPathId: resolvedInstruction.color_path_id,
          transitions: singleElementTimingPosition
            ? await buildTransitionValues(
                transitionResolver,
                cue,
                resolvedInstruction,
                transitionAttrs,
                singleElementTimingPosition,
                parentFixtureRef,
              )
            : await buildFixtureTransitionValues(
                transitionResolver,
                cue,
                { ...item, cue_instruction: resolvedInstruction },
                fixturesByUid,
                fixture.identifiers.uid,
                transitionAttrs,
              ),
        };
        conflictRows.push(fixtureRow);
        if (visible) {
          appendVisibleFixtureRow(
            flatRows,
            groupedElementParentRows,
            fixtureRow,
            {
              displayMode,
              expandedFixtures,
              includeElementRows,
              instructionSelectsWholeFixture,
            },
          );
          visibleParentFixtureUids.add(fixture.identifiers.uid);
        }
      }
    }
  };

  await processInstructions(cue.instructions, undefined, "p0", partId === 0);

  for (const [partIndex, part] of (cue.parts ?? []).entries()) {
    await processInstructions(
      part.instructions,
      partIndex,
      `p${part.identifiers.id}`,
      part.identifiers.id === partId,
    );
  }

  markCueValueConflicts(conflictRows);

  if (includeTrackedRows) {
    const activePartIndex =
      partId === 0
        ? undefined
        : (cue.parts ?? []).findIndex((part) => part.identifiers.id === partId);
    const trackedRowPartIndex =
      activePartIndex === undefined || activePartIndex < 0
        ? undefined
        : activePartIndex;
    const trackedRowPartLabel =
      trackedRowPartIndex === undefined
        ? undefined
        : `p${cue.parts?.[trackedRowPartIndex]?.identifiers.id ?? partId}`;
    for (const fixture of allFixtures) {
      if (visibleParentFixtureUids.has(fixture.identifiers.uid)) continue;
      const parentFixtureRef = { fixture_uid: fixture.identifiers.uid };
      const parentApplicableAttributes = getFixtureAttributeNames(fixture);
      const trackedAttributes = trackedAttributesForFixture(
        parentFixtureRef,
        parentApplicableAttributes,
        trackedValues,
        fixture,
      );
      const trackedAttributeSources = trackedSourcesForFixture(
        parentFixtureRef,
        trackedAttributes,
        trackedValues,
        fixture,
      );
      const lookaheadAttributes = lookaheadAttributesForFixture(
        parentFixtureRef,
        parentApplicableAttributes,
        lookaheadValues,
      );
      const rowHasDisplayValues =
        Object.keys(trackedAttributes).length > 0 ||
        Object.keys(lookaheadAttributes).length > 0;
      if (!rowHasDisplayValues) continue;

      flatRows.push({
        type: "parent",
        uid: `tracked:${fixture.identifiers.uid}`,
        fixtureUid: fixture.identifiers.uid,
        id: fixture.identifiers.id,
        sourceLabel:
          Object.keys(trackedAttributes).length > 0 ? "Tracked" : "Lookahead",
        label: fixture.identifiers.label,
        selectionIndex: -1,
        instructionTargets: [],
        partIndex: trackedRowPartIndex,
        partLabel: trackedRowPartLabel,
        fixtureRef: parentFixtureRef,
        expansionKey: `tracked:${fixture.identifiers.uid}`,
        hasElements: false,
        isExpanded: false,
        selectedElementRows: [],
        applicableAttributes: parentApplicableAttributes,
        attributes: { abs: {}, rel: {}, release: new Set<string>() },
        trackedAttributes,
        trackedAttributeSources,
        lookaheadAttributes,
        lookaheadAttributeSources: lookaheadSourcesForFixture(
          parentFixtureRef,
          lookaheadAttributes,
          lookaheadValues,
        ),
        conflictingValues: new Set<string>(),
        valueConflicts: new Map<string, CueValueConflict>(),
        transitions: {},
      });
    }
  }

  return { groups: [], flatRows: flatRows.sort(compareCueFixtureRowsById) };
}

/** Builds the stable writer group key used to detect overlapping fixture writes. */
export function cueValueConflictWriterKey(
  row: CueFixtureRow,
  valueKey: string,
): string {
  return `${fixtureRefKey(row.fixtureRef)}:${valueKey}`;
}

/** Marks value cells that are written by more than one instruction row. */
export function markCueValueConflicts(rows: CueFixtureRow[]) {
  const writers = new Map<
    string,
    Array<{ row: CueFixtureRow; valueKey: string; attr: string }>
  >();

  for (const row of rows) {
    const attrs = new Set([
      ...Object.keys(row.attributes.abs),
      ...Object.keys(row.attributes.rel),
      ...row.attributes.release,
    ]);
    for (const attr of attrs) {
      const valueKey = cueAttributeValueColumnId(attr);
      const writerKey = cueValueConflictWriterKey(row, valueKey);
      const rowWriters = writers.get(writerKey) ?? [];
      rowWriters.push({ row, valueKey, attr });
      writers.set(writerKey, rowWriters);
    }
  }

  for (const rowWriters of writers.values()) {
    if (rowWriters.length <= 1) continue;
    const conflictWriters = rowWriters.map(({ row, attr }) => {
      const blueprintSource = cueRowAssertionValue(row, attr)?.blueprintSource;
      return {
        sourceLabel: blueprintSource
          ? `${row.sourceLabel} · BP ${blueprintSource.blueprint_id} ${blueprintSource.blueprint_label}`
          : row.sourceLabel,
        instructionIndex: row.selectionIndex,
        valueLabel: formatCueConflictValue(row, attr),
      };
    });
    const winningWriter = conflictWriters[conflictWriters.length - 1];
    if (!winningWriter) continue;
    const conflict: CueValueConflict = {
      attribute: rowWriters[0]!.attr,
      fixtureLabel:
        rowWriters[0]!.row.label.trim() || `Fixture ${rowWriters[0]!.row.id}`,
      writers: conflictWriters,
      winningWriter,
    };
    for (const { row, valueKey } of rowWriters) {
      row.conflictingValues.add(valueKey);
      row.valueConflicts.set(valueKey, conflict);
    }
  }
}

/** Resolves the timing displayed by a row, including uniform overrides on collapsed elements. */
export function displayedTimingForField(
  row: CueFixtureRow,
  attr: string,
  field: TimingField,
): { timing: CueTimingValue; varied: boolean } {
  const parentTiming = row.transitions[attr]?.[field];
  const aggregate = aggregateParentElementTiming(row, attr, field);
  const assertedParent =
    parentTiming && !parentTiming.inherited ? parentTiming : undefined;
  const assertedElements =
    aggregate && aggregate !== "mixed" && !aggregate.inherited
      ? aggregate
      : undefined;
  return {
    timing: assertedParent ??
      assertedElements ??
      parentTiming ?? { value: 0, inherited: true },
    varied: aggregate === "mixed",
  };
}

/** Computes the preview progress fill for one timing cell. */
export function timingProgressForField(
  row: CueFixtureRow,
  attr: string,
  field: TimingField,
  clock: PlaybackTransitionClock | undefined,
): number | undefined {
  if (!clock) return undefined;

  const transition = row.transitions[attr];
  if (!transition) return undefined;

  if (
    (clock.phase === "in" && (field === "delay_out" || field === "fade_out")) ||
    (clock.phase === "out" && (field === "delay_in" || field === "fade_in"))
  ) {
    return undefined;
  }

  const { elapsedSeconds } = clock;

  const resolved = displayedTimingForField(row, attr, field);
  if (resolved.varied && resolved.timing.inherited) return undefined;
  const delayField = clock.phase === "in" ? "delay_in" : "delay_out";
  const resolvedDelay = displayedTimingForField(row, attr, delayField);
  if (
    field.startsWith("fade") &&
    resolvedDelay.varied &&
    resolvedDelay.timing.inherited
  )
    return undefined;
  const delay = resolvedDelay.timing.value;
  const duration = resolved.timing.value;

  switch (field) {
    case "delay_in":
      return duration <= 0 ? 1 : clamp(elapsedSeconds / duration, 0, 1);
    case "fade_in": {
      const fadeElapsed = elapsedSeconds - delay;
      if (fadeElapsed < 0) return 0;
      return duration <= 0 ? 1 : clamp(fadeElapsed / duration, 0, 1);
    }
    case "delay_out":
      return duration <= 0 ? 1 : clamp(elapsedSeconds / duration, 0, 1);
    case "fade_out": {
      const fadeElapsed = elapsedSeconds - delay;
      if (fadeElapsed < 0) return 0;
      return duration <= 0 ? 1 : clamp(fadeElapsed / duration, 0, 1);
    }
  }
}

/** Resolves the timing value a parent row should display from nested element rows. */
export function aggregateParentElementTiming(
  row: CueFixtureRow,
  attr: string,
  field: TimingField,
): CueTimingValue | "mixed" | undefined {
  if (row.type !== "parent" || row.selectedElementRows.length === 0) {
    return undefined;
  }

  const timings = row.selectedElementRows
    .filter((elementRow) => elementRow.applicableAttributes.has(attr))
    .map((elementRow) => elementRow.transitions[attr]?.[field])
    .filter((timing): timing is CueTimingValue => timing !== undefined);
  const first = timings[0];
  if (!first) return undefined;

  const uniform = timings.every((timing) => timing.value === first.value);
  if (!uniform) return "mixed";
  return {
    value: first.value,
    inherited: timings.every((timing) => timing.inherited),
  };
}

/** Inner component that uses the cue editor context */
