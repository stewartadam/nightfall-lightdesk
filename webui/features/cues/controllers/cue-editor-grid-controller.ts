// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { createKeyedDataGridCellProvider } from "../../../components/widgets/data-grid";
import { sortedAttributes } from "../../../lib/attribute-ordering";
import { isColorPathDrivenAttribute } from "../../../lib/color-path-driven-attributes";
import { TIMING_COLUMNS } from "../../../lib/cue-timing-values";
import type { GridCell } from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import {
  applyAggregateConflictStyling,
  applyElementBackground,
  applyLookaheadStyling,
  applyTrackedValueStyling,
  attributeValueColumnWidth,
  CONFLICT_VALUE_TEXT_COLOR,
  createAttributeValueCell,
  formatIdWithChevron,
  makeNotApplicableCell,
} from "../../../lib/datagrid";
import { filterVisibleColumns } from "../../../lib/datagrid-column-visibility";
import {
  makeTimeCell,
  type RichTimeDisplayUnit,
} from "../../../lib/datagrid-rich-cells";
import { msToDuration } from "../../../lib/duration";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { normalizeAttributeName } from "../../../lib/utils";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import {
  activeInstances,
  blueprints as blueprintStore,
  cues as cueStore,
  fixtures as fixtureStore,
  layerStack,
  sequences as sequenceStore,
} from "../../../state/appStores";
import {
  findTopmostCuePlayback,
  findTopmostSequencePlayback,
  type PlaybackTransitionClock,
  playbackTransitionClock,
} from "../../cue-sequences";
import type { CueEditorContextType } from "../context/cue-editor-context";
import {
  aggregateParentElementAssertion,
  parentElementAssertionsVaried,
} from "../model/cue-editor-blueprint-model";
import {
  applyColorPathDrivenStyling,
  type CueGridColumn,
  cueAttributeTimingColumnId,
  cueAttributeValueColumnId,
  cueColumnVisibilityMeta,
  displayedTimingForField,
  INHERITED_TIMING_TEXT_COLOR,
  lookaheadValuesForCue,
  makeEditableTrackedEmptyValueCell,
  type ProcessedCueData,
  processCueInstructions,
  rowSupportsValueAttribute,
  timingColumnForGridColumn,
  timingProgressForField,
  trackedValuesBeforeCue,
} from "../model/cue-editor-model";

interface CueEditorGridControllerOptions {
  panelId: string;
  context: CueEditorContextType;
  displayMode: Accessor<"values" | "timings">;
  showTrackedValues: Accessor<boolean>;
  expandedFixtures: Accessor<Set<string>>;
  cueGridRevision: Accessor<number>;
  timingColumnDisplayUnits: Accessor<Record<string, RichTimeDisplayUnit>>;
  defaultTimingDisplayUnit: Accessor<RichTimeDisplayUnit>;
}

/** Owns cue row projection, column configuration, and cell presentation. */
export function createCueEditorGridController(
  options: CueEditorGridControllerOptions,
) {
  const workspaceActive = useWorkspaceActivity();
  const ctx = options.context;
  const displayMode = options.displayMode;
  const showTrackedValues = options.showTrackedValues;
  const expandedFixtures = options.expandedFixtures;
  const cueGridRevision = options.cueGridRevision;
  const timingColumnDisplayUnits = options.timingColumnDisplayUnits;
  const defaultTimingDisplayUnit = options.defaultTimingDisplayUnit;
  const $allFixtures = useStore(fixtureStore);
  const $blueprints = useShallowStore(blueprintStore);
  const $allCues = useShallowStore(cueStore);
  const $allSequences = useShallowStore(sequenceStore);
  const $activeInstances = useShallowStore(activeInstances);
  const $layerStack = useShallowStore(layerStack);
  const [previewClockMs, setPreviewClockMs] = createSignal(performance.now());

  /** Advances the cue timing clock while preview or live playback can show progress. */
  createEffect(() => {
    if (!workspaceActive()) return;
    if (!ctx.previewActive() && Object.keys($activeInstances()).length === 0) {
      return;
    }

    setPreviewClockMs(performance.now());

    let frameId = 0;
    /** Queues the next animation-frame clock update for timing-cell progress fills. */
    const tick = () => {
      setPreviewClockMs(performance.now());
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frameId));
  });

  const emptyProcessedCueData: ProcessedCueData = { groups: [], flatRows: [] };

  /** Tracks the source data needed to derive visible cue grid rows. */
  const processedDataInput = createMemo(() => {
    const loadingState = ctx.loadingState();
    const currentCue =
      loadingState.status === "loaded" ? loadingState.cue : undefined;
    const fixtureMap = $allFixtures();
    const cueMap = $allCues();
    const sequenceMap = $allSequences();
    const fixtureArray = Object.values(fixtureMap);
    const includeTrackedRows =
      displayMode() === "values" && showTrackedValues();
    const layers = includeTrackedRows ? $layerStack() : [];
    const sequenceId = ctx.sequenceId();
    const sequence = Object.values(sequenceMap).find(
      (candidate) => candidate.identifiers.id === sequenceId,
    );
    return {
      cue: currentCue,
      cueMap,
      fixtures: fixtureArray,
      partId: ctx.partId,
      expanded: expandedFixtures(),
      displayMode: displayMode(),
      includeElementRows: true,
      includeTrackedRows,
      layers,
      revision: cueGridRevision(),
      sequence,
      blueprints: $blueprints(),
    };
  });

  /** Derives visible cue grid rows from Rust-projected spatial timing indexes. */
  const [processedData] = createResource(
    processedDataInput,
    async (input) => {
      if (!input.cue || input.fixtures.length === 0) {
        return emptyProcessedCueData;
      }
      const trackedValues = await trackedValuesBeforeCue(
        input.sequence,
        input.cueMap,
        input.cue,
        input.blueprints,
      );
      const lookaheadValues = await lookaheadValuesForCue(
        input.sequence,
        input.cueMap,
        input.cue,
        input.layers,
      );
      return processCueInstructions(
        input.cue,
        input.fixtures,
        input.partId,
        input.expanded,
        input.displayMode,
        input.includeElementRows,
        input.includeTrackedRows,
        trackedValues,
        lookaheadValues,
        input.blueprints,
      );
    },
    { initialValue: emptyProcessedCueData },
  );

  /** Returns the current flattened grid row list. */
  const flatRows = () => processedData().flatRows;

  /** Returns whether the editor should show its toolbar despite an empty grid. */
  const canShowEmptyCueToolbar = () =>
    !ctx.isReleaseCue && ctx.sequenceId() !== undefined;

  /** Derives attribute columns that should be visible by default for this cue view. */
  const defaultVisibleAttributeColumns = createMemo(() => {
    const attributeSet = new Set<string>();
    const rows = flatRows();

    for (const row of rows) {
      for (const attr of Object.keys(row.attributes.abs)) {
        attributeSet.add(normalizeAttributeName(attr));
      }
      for (const attr of Object.keys(row.attributes.rel)) {
        attributeSet.add(normalizeAttributeName(attr));
      }
      for (const attr of row.attributes.release) {
        attributeSet.add(normalizeAttributeName(attr));
      }
      if (displayMode() === "values" && showTrackedValues()) {
        for (const attr of Object.keys(row.trackedAttributes)) {
          attributeSet.add(normalizeAttributeName(attr));
        }
        for (const attr of Object.keys(row.lookaheadAttributes)) {
          attributeSet.add(normalizeAttributeName(attr));
        }
      }
      for (const attr of Object.keys(row.transitions)) {
        attributeSet.add(normalizeAttributeName(attr));
      }
    }

    return attributeSet;
  });

  /** Derives attributes supported by cue rows, including tracked rows when shown. */
  const compatibleAttributeColumns = createMemo(() => {
    const attributeSet = new Set<string>();

    for (const row of flatRows()) {
      for (const attr of row.applicableAttributes) {
        if (!rowSupportsValueAttribute(row, attr)) continue;
        attributeSet.add(normalizeAttributeName(attr));
      }
    }

    return sortedAttributes([...attributeSet]);
  });

  /** Builds the complete data grid column model for value or timing display mode. */
  const allColumns = createMemo((): CueGridColumn[] => {
    const baseColumns: CueGridColumn[] = [
      { title: "ID", id: "id", width: 60 },
      { title: "Label", id: "label", width: 170 },
      { title: "Source", id: "source", width: 100 },
    ];

    const defaultVisibleAttrs = defaultVisibleAttributeColumns();
    const attrs = sortedAttributes([
      ...new Set([...compatibleAttributeColumns(), ...defaultVisibleAttrs]),
    ]);
    if (displayMode() === "values") {
      return [
        ...baseColumns,
        ...attrs.map(
          (attr): CueGridColumn => ({
            title: "Value",
            id: cueAttributeValueColumnId(attr),
            width: flatRows().some(
              (row) =>
                (
                  row.attributes.rel[attr] ??
                  row.attributes.abs[attr] ??
                  aggregateParentElementAssertion(row, attr)
                )?.blueprintSource !== undefined,
            )
              ? 200
              : attributeValueColumnWidth(),
            sizing: "fixed",
            group: normalizeAttributeName(attr),
            cueAttribute: attr,
            cueColumnKind: "value",
            ...cueColumnVisibilityMeta(
              attr,
              "Value",
              defaultVisibleAttrs.has(attr),
            ),
          }),
        ),
      ];
    }
    const timingColumns = attrs.flatMap((attr) =>
      TIMING_COLUMNS.map(
        ({ field, title }): CueGridColumn => ({
          title,
          id: cueAttributeTimingColumnId(attr, field),
          group: normalizeAttributeName(attr),
          width: 70,
          sizing: "fixed",
          cueAttribute: attr,
          cueColumnKind: "timing",
          cueTimingField: field,
          ...cueColumnVisibilityMeta(
            attr,
            title,
            defaultVisibleAttrs.has(attr),
          ),
        }),
      ),
    );
    return [...baseColumns, ...timingColumns];
  });

  /** Applies persisted cue editor column visibility to the complete column model. */
  const columns = createMemo((): CueGridColumn[] =>
    filterVisibleColumns(allColumns(), options.panelId),
  );

  /** Invalidates intrinsic sizing only when width-relevant cue state changes. */
  const contentSizingKey = createMemo(() => ({
    rows: flatRows(),
    columns: columns(),
    columnDisplayUnits: timingColumnDisplayUnits(),
    defaultDisplayUnit: defaultTimingDisplayUnit(),
    mode: displayMode(),
    displayTrackedValues: showTrackedValues(),
  }));

  /** Builds the cell renderer callback with the current reactive preview and row state. */
  const cellProvider = createMemo(() => {
    // inside reactive context
    const nowMs = previewClockMs();
    const previewActive = ctx.previewActive();
    const previewApplyTransitions = ctx.previewApplyTransitions();
    const previewStartedAtMs = ctx.previewStartedAtMs();
    const playback =
      ctx.isReleaseCue && ctx.releaseSequenceUid
        ? findTopmostSequencePlayback(
            $activeInstances(),
            $layerStack(),
            ctx.releaseSequenceUid,
          )
        : findTopmostCuePlayback($activeInstances(), $layerStack(), ctx.cueUid);
    const rawInstanceClock =
      playback?.is_preview && !previewApplyTransitions
        ? undefined
        : playbackTransitionClock(playback, Date.now());
    const playbackClock =
      rawInstanceClock?.phase === (ctx.isReleaseCue ? "out" : "in")
        ? rawInstanceClock
        : undefined;
    const previewClock =
      previewActive &&
      previewApplyTransitions &&
      previewStartedAtMs !== undefined
        ? ({
            phase: "in",
            elapsedSeconds: Math.max(0, (nowMs - previewStartedAtMs) / 1000),
          } satisfies PlaybackTransitionClock)
        : undefined;
    const transitionClock = playbackClock ?? previewClock;
    const columnDisplayUnits = timingColumnDisplayUnits();
    const defaultDisplayUnit = defaultTimingDisplayUnit();
    const mode = displayMode();
    const displayTrackedValues = showTrackedValues();
    return createKeyedDataGridCellProvider({
      rows: flatRows(),
      columns: columns(),
      contentSizingKey: contentSizingKey(),
      rowKey: (row) => row.uid,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        // outside reactive context
        const colId = column.id ?? "unknown";
        const isParent = item.type === "parent";
        const isElement = item.type === "element";

        if (colId === "id") {
          const displayData = formatIdWithChevron(
            item.id,
            item.type,
            isParent ? item.hasElements : false,
            isParent ? item.isExpanded : false,
            isElement ? item.elementIndex : undefined,
          );
          return applyElementBackground(
            {
              kind: GridCellKind.Text,
              data: String(item.id),
              displayData,
              allowOverlay: false,
            },
            isElement,
          );
        }

        if (colId === "source") {
          return {
            kind: GridCellKind.Text,
            data: item.sourceLabel,
            displayData: item.sourceLabel,
            allowOverlay: false,
            themeOverride:
              item.partIndex === undefined
                ? { textDark: "#a3a3a3" }
                : { textDark: "#93c5fd" },
          };
        }

        if (colId === "label") {
          return applyElementBackground(
            {
              kind: GridCellKind.Text,
              data: item.label,
              displayData: item.label,
              allowOverlay: false,
            },
            isElement,
          );
        }

        // Handle attribute columns based on display mode
        if (mode === "values") {
          const cueColumn = column as CueGridColumn;
          if (cueColumn.cueColumnKind === "value" && cueColumn.cueAttribute) {
            const attr = cueColumn.cueAttribute;
            if (!rowSupportsValueAttribute(item, attr)) {
              return applyElementBackground(makeNotApplicableCell(), isElement);
            }
            const colorPathId = isColorPathDrivenAttribute(
              item.colorPathId,
              attr,
            )
              ? item.colorPathId
              : undefined;
            if (item.attributes.release.has(attr)) {
              const hasConflict = item.conflictingValues.has(colId);
              const releaseCell: GridCell = {
                kind: GridCellKind.Text,
                data: "R",
                displayData: "R",
                allowOverlay: false,
                themeOverride: hasConflict
                  ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                  : undefined,
              };
              const cell = parentElementAssertionsVaried(item, attr)
                ? applyAggregateConflictStyling(
                    releaseCell,
                    true,
                    hasConflict ? CONFLICT_VALUE_TEXT_COLOR : undefined,
                    {
                      preserveValue: true,
                    },
                  )
                : releaseCell;
              return applyElementBackground(
                applyColorPathDrivenStyling(cell, colorPathId),
                isElement,
              );
            }
            const val =
              item.attributes.rel[attr] ??
              item.attributes.abs[attr] ??
              aggregateParentElementAssertion(item, attr);
            if (val) {
              const hasConflict = item.conflictingValues.has(colId);
              const valueCell = createAttributeValueCell(val, {
                themeOverride: hasConflict
                  ? { textDark: CONFLICT_VALUE_TEXT_COLOR }
                  : undefined,
              });
              const cell = parentElementAssertionsVaried(item, attr)
                ? applyAggregateConflictStyling(
                    valueCell,
                    true,
                    hasConflict ? CONFLICT_VALUE_TEXT_COLOR : undefined,
                    {
                      preserveValue: true,
                    },
                  )
                : valueCell;
              return applyElementBackground(
                applyColorPathDrivenStyling(cell, colorPathId),
                isElement,
              );
            }
            if (displayTrackedValues) {
              const lookaheadValue = item.lookaheadAttributes[attr];
              if (lookaheadValue) {
                return applyElementBackground(
                  applyLookaheadStyling(
                    createAttributeValueCell(lookaheadValue, {
                      allowOverlay: true,
                    }),
                  ),
                  isElement,
                );
              }
              const trackedValue = item.trackedAttributes[attr];
              if (trackedValue) {
                return applyElementBackground(
                  applyColorPathDrivenStyling(
                    applyTrackedValueStyling(
                      createAttributeValueCell(trackedValue, {
                        allowOverlay: true,
                      }),
                    ),
                    colorPathId,
                  ),
                  isElement,
                );
              }
            }
            if (parentElementAssertionsVaried(item, attr)) {
              return applyElementBackground(
                applyAggregateConflictStyling(
                  createAttributeValueCell(undefined, { allowOverlay: true }),
                  true,
                ),
                isElement,
              );
            }
            return applyElementBackground(
              displayTrackedValues
                ? makeEditableTrackedEmptyValueCell()
                : createAttributeValueCell(undefined, { allowOverlay: true }),
              isElement,
            );
          }
        } else {
          const timingColumn = timingColumnForGridColumn(column);
          if (timingColumn) {
            const { attr, field } = timingColumn;
            if (!item.applicableAttributes.has(attr)) {
              return applyElementBackground(makeNotApplicableCell(), isElement);
            }
            const { timing, varied: childTimingsVaried } =
              displayedTimingForField(item, attr, field);
            const backgroundFill = timingProgressForField(
              item,
              attr,
              field,
              transitionClock,
            );
            const cell: GridCell = makeTimeCell(
              {
                value: msToDuration(timing.value * 1000),
                displayUnit: columnDisplayUnits[colId] ?? defaultDisplayUnit,
                badges: childTimingsVaried
                  ? [
                      {
                        label: "V",
                        tone: "warning",
                        title: "Element timings vary",
                      },
                    ]
                  : undefined,
                minMs: 0,
                placeholder: "1s",
                clearable: true,
                backgroundFill,
                backgroundFillColor: "rgba(59, 130, 246, 0.42)",
              },
              { allowOverlay: true },
            );
            const styledCell = !timing.inherited
              ? cell
              : {
                  ...cell,
                  themeOverride: {
                    ...cell.themeOverride,
                    textDark: INHERITED_TIMING_TEXT_COLOR,
                  },
                };
            return applyElementBackground(styledCell, isElement);
          }
        }

        return applyElementBackground(
          {
            kind: GridCellKind.Text,
            data: "",
            displayData: "",
            allowOverlay: false,
          },
          isElement,
        );
      },
    });
  });

  return {
    allColumns,
    canShowEmptyCueToolbar,
    cellProvider,
    columns,
    flatRows,
  };
}
