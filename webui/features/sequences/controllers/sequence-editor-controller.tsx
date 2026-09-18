// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { DockviewPanelApi } from "dockview";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import type {
  GridColumn,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import type { RichTimeDisplayUnit } from "../../../lib/datagrid-rich-cells";
import {
  registerComponentFocus,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { buildSequencePreviewCue } from "../../../lib/sequence-preview-cue";
import { timeDisplayUnitFromPreference } from "../../../lib/time-display-units";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  cueDurationProfiles,
  sequenceLookaheadStates,
} from "../../../state/appStores";
import { $settings } from "../../../state/settings";
import {
  selectedTimeDisplayColumnIds,
  TransitionScrubber,
  timeUnitContextMenuEntries,
} from "../../cue-sequences";
import { usePropertiesInspector } from "../../property-inspector";
import { SequenceEditorGrid } from "../components/sequence-editor-grid";
import { SequenceEditorToolbar } from "../components/sequence-editor-toolbar";
import SequenceProperties from "../components/sequence-properties";
import {
  SequenceEditorContextProvider,
  type SequenceEditorContextType,
} from "../context/sequence-editor-context";
import { sequenceDurationSummary } from "../model/sequence-duration";
import {
  applyLookaheadRowState,
  cueBasePartToGridRow,
  cuePartConflictIds,
  cuePartToGridRow,
  cueToGridRow,
  editorTargetForRow,
  isMetaCueRow,
  isSequenceSummaryRow,
  isTimeDisplayColumnId,
  releaseTriggerDisplay,
  type SequenceConflictTooltipState,
  type SequenceGridRow,
  sequenceDurationSummaryRow,
  sequenceLookaheadRowsByKey,
} from "../model/sequence-editor-model";
import { createSequenceEditorEditController } from "./sequence-editor-edit-controller";
import { createSequenceEditorGridController } from "./sequence-editor-grid-controller";
import { createSequenceEditorSelectionController } from "./sequence-editor-selection-controller";

/** Coordinates sequence grid state, editing commands, and feature presentation. */
export function SequenceEditorController(props: {
  panelId: string;
  contextValue: SequenceEditorContextType;
  panelApi?: DockviewPanelApi;
}) {
  let rootRef!: HTMLDivElement;
  const ctx = props.contextValue;
  const $sequenceLookaheadStates = useShallowStore(sequenceLookaheadStates);
  const $cueDurationProfiles = useShallowStore(cueDurationProfiles);
  const settings = useStore($settings);
  const [expandedCueUids, setExpandedCueUids] = createSignal<Set<string>>(
    new Set(),
  );
  const [timingColumnDisplayUnits, setTimingColumnDisplayUnits] = createSignal<
    Record<string, RichTimeDisplayUnit>
  >({});
  const [conflictTooltip, setConflictTooltip] =
    createSignal<SequenceConflictTooltipState>();
  let conflictTooltipTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let conflictTooltipId = 0;
  const defaultTimingDisplayUnit = createMemo(() =>
    timeDisplayUnitFromPreference(settings().time_display_preference),
  );

  /** Clears any pending or visible sequence conflict tooltip. */
  const clearConflictTooltip = () => {
    if (conflictTooltipTimeoutId !== undefined) {
      clearTimeout(conflictTooltipTimeoutId);
      conflictTooltipTimeoutId = undefined;
    }
    setConflictTooltip(undefined);
  };

  /** Returns the conflict help text for sequence label cells. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    const [col, row] = cell;
    const rowData = rows()[row];
    const columnId = columns()[col]?.id;
    if (columnId !== "label" || !rowData?.hasPartConflict) {
      return undefined;
    }
    if (rowData.rowKind === "cue") {
      return "This cue has parts with fixture values that conflict. Open the cue for details.";
    }
    return "This cue part has fixture values that conflict with another part. Open the cue for details.";
  };

  /** Returns the warning glyph bounds within a sequence label cell. */
  const conflictIconAnchorRect = (element: HTMLElement): DOMRect => {
    const rect = element.getBoundingClientRect();
    return new DOMRect(rect.left + 8, rect.top, 16, rect.height);
  };

  /** Schedules a delayed tooltip for conflicted sequence part labels. */
  const onCellHovered = (cell: Item | undefined, element?: HTMLElement) => {
    clearConflictTooltip();
    if (!cell || !element) return;

    const content = conflictTooltipContentForCell(cell);
    if (!content) return;

    conflictTooltipTimeoutId = setTimeout(() => {
      setConflictTooltip({
        id: ++conflictTooltipId,
        content,
        anchorRect: conflictIconAnchorRect(element),
      });
      conflictTooltipTimeoutId = undefined;
    }, 500);
  };

  /** Hides pending conflict hover UI when the editor unmounts. */
  onCleanup(clearConflictTooltip);
  /** Returns the panel-local display unit for a timing column. */
  const timingDisplayUnit = (columnId: string | undefined) =>
    columnId
      ? (timingColumnDisplayUnits()[columnId] ?? defaultTimingDisplayUnit())
      : defaultTimingDisplayUnit();

  /** Stores panel-local display unit overrides for timing columns. */
  const setTimingColumnDisplayUnitsForColumns = (
    columnIds: readonly string[],
    unit: RichTimeDisplayUnit,
  ) => {
    setTimingColumnDisplayUnits((previous) => {
      const next = { ...previous };
      for (const columnId of columnIds) {
        next[columnId] = unit;
      }
      return next;
    });
  };

  /** Keeps the retained panel title aligned with its sequence label. */
  createEffect(() => {
    props.panelApi?.setTitle(ctx.label());
  });

  usePropertiesInspector(
    props.panelId,
    ctx.label,
    () => (
      <SequenceEditorContextProvider value={props.contextValue}>
        <SequenceProperties />
      </SequenceEditorContextProvider>
    ),
    { priority: 10 },
  );

  /** Resolves cue part conflict IDs through spatial projection semantics. */
  const cuePartConflictInput = createMemo(() =>
    ctx.cueRows().map((row) => ({ cueUid: row.cueUid, cue: row.cue })),
  );

  /** Stores async conflict IDs keyed by cue UID for visible sequence rows. */
  const [cuePartConflictIdsByCueUid] = createResource(
    cuePartConflictInput,
    async (cueRows) => {
      const entries: Array<[string, Set<number>]> = [];
      for (const row of cueRows) {
        if (!row.cue) continue;
        entries.push([row.cueUid, await cuePartConflictIds(row.cue)]);
      }
      return new Map(entries);
    },
    { initialValue: new Map<string, Set<number>>() },
  );

  /** Returns backend duration inputs needed by the Rust sequence summary bridge. */
  const sequenceDurationSummaryInput = createMemo(() => ({
    cueRows: ctx.cueRows(),
    sequence: ctx.sequence(),
    cueDurationProfiles: $cueDurationProfiles(),
  }));

  /** Stores Rust-computed sequence start offsets and duration values for cue rows. */
  const [durationSummary] = createResource(
    sequenceDurationSummaryInput,
    ({ cueRows, sequence, cueDurationProfiles }) =>
      sequenceDurationSummary(cueRows, sequence, cueDurationProfiles),
    {
      initialValue: {
        startTimesByCueUid: new Map<string, number | undefined>(),
        durationsByCueUid: new Map<string, number | undefined>(),
        total: undefined,
      },
    },
  );

  const rows = createMemo(() => {
    const sequence = ctx.sequence();
    const defaultTiming = sequence?.default_timing;
    const expanded = expandedCueUids();
    const conflictIdsByCueUid = cuePartConflictIdsByCueUid();
    const currentDurationSummary = durationSummary();
    const lookaheadStatesByRowKey = sequenceLookaheadRowsByKey(
      sequence
        ? $sequenceLookaheadStates()[sequence.identifiers.uid]
        : undefined,
    );
    const cueRows: SequenceGridRow[] = [];
    for (const row of ctx.cueRows()) {
      const conflictingPartIds =
        conflictIdsByCueUid.get(row.cueUid) ?? new Set<number>();
      const cueRow = cueToGridRow(row, defaultTiming, {
        hasPartConflict: conflictingPartIds.size > 0,
        releaseTrigger: row.isReleaseCue
          ? releaseTriggerDisplay(sequence)
          : undefined,
        sequenceWrap: sequence?.wrap,
      });
      cueRows.push(cueRow);
      if (!row.cue || !expanded.has(row.cueUid)) continue;

      cueRows.push(
        cueBasePartToGridRow(row.cueUid, row.cue, row.index, defaultTiming, {
          isSetupCue: row.isSetupCue,
          isReleaseCue: row.isReleaseCue,
          hasPartConflict: conflictingPartIds.has(0),
        }),
      );
      for (const [partIndex, part] of (row.cue.parts ?? []).entries()) {
        cueRows.push(
          cuePartToGridRow(
            row.cueUid,
            row.cue,
            part,
            partIndex,
            row.index,
            defaultTiming,
            {
              isSetupCue: row.isSetupCue,
              isReleaseCue: row.isReleaseCue,
              hasPartConflict: conflictingPartIds.has(part.identifiers.id),
            },
          ),
        );
      }
    }

    const rowsWithDurations = cueRows.map((row) =>
      applyLookaheadRowState(
        row.rowKind === "cue"
          ? {
              ...row,
              startTime: currentDurationSummary.startTimesByCueUid.get(
                row.cueUid,
              ),
              duration: currentDurationSummary.durationsByCueUid.get(
                row.cueUid,
              ),
            }
          : row,
        lookaheadStatesByRowKey,
      ),
    );
    rowsWithDurations.push(
      sequenceDurationSummaryRow(currentDurationSummary.total),
    );
    return rowsWithDurations;
  });

  createEffect(() => {
    const cueRows = ctx.cueRows();
    setExpandedCueUids((previous) => {
      const validCueUids = new Set(
        cueRows
          .filter((row) => (row.cue?.parts?.length ?? 0) > 0)
          .map((row) => row.cueUid),
      );
      const next = new Set(
        [...previous].filter((cueUid) => validCueUids.has(cueUid)),
      );
      return next.size === previous.size ? previous : next;
    });
  });

  const columns = createMemo((): GridColumn[] => [
    { title: "Cue", id: "cue_id", width: 70 },
    { title: "Label", id: "label", width: 220 },
    { title: "Lookahead", id: "lookahead", width: 110 },
    { title: "Trigger", id: "trigger", width: 130, group: "Cue Entry" },
    { title: "Time", id: "after_delay", width: 90, group: "Cue Entry" },
    { title: "Fade In", id: "fade_in", width: 90, group: "In" },
    { title: "Delay In", id: "delay_in", width: 90, group: "In" },
    { title: "Fade Out", id: "fade_out", width: 90, group: "Out" },
    { title: "Delay Out", id: "delay_out", width: 90, group: "Out" },
    { title: "Start", id: "start_time", width: 90, group: "Computed" },
    { title: "Duration", id: "duration", width: 100, group: "Computed" },
    { title: "Tracking", id: "tracking", width: 210 },
  ]);

  const {
    canDeleteSelectedEditorRow,
    canDuplicateSelectedCue,
    canMoveSelection,
    clearTimingOverridesForSelection,
    deleteSelectedEditorRow,
    duplicateSelectedCue,
    gridSelection,
    handleGridSelectionChange,
    hasPreviewableCue,
    moveSelectedCue,
    openSelectedCueEditor,
    selectedDeleteLabel,
    selectedEditorRow,
    setLastClickedRow,
    setSelectedEditorTarget,
  } = createSequenceEditorSelectionController({
    context: ctx,
    rows,
    columns,
    cuePartConflictIdsByCueUid,
  });

  const handlePriorityKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!rootRef.contains(target)) return;

    const editingTextInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (
      !editingTextInput &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === "Delete" || event.key === "Backspace")
    ) {
      if (clearTimingOverridesForSelection(gridSelection())) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        event.stopPropagation();
        duplicateSelectedCue();
      }
    }
  };

  createEffect(() => {
    if (!rootRef) return;
    const unregister = registerComponentFocus(props.panelId, rootRef);
    rootRef.addEventListener("keydown", handlePriorityKeyDown, {
      capture: true,
    });
    onCleanup(() => unregister());
    onCleanup(() => {
      rootRef.removeEventListener("keydown", handlePriorityKeyDown, {
        capture: true,
      });
    });
  });

  useKeyboardShortcut({
    key: "Alt+ArrowUp",
    handler: () => moveSelectedCue(-1),
    description: "Move selected cue up",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "Alt+ArrowDown",
    handler: () => moveSelectedCue(1),
    description: "Move selected cue down",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "$mod+d",
    handler: duplicateSelectedCue,
    description: "Duplicate selected cue",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "Control+ArrowLeft",
    handler: ctx.previewBack,
    description: "Preview previous cue",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "Control+ArrowRight",
    handler: ctx.previewGo,
    description: "Preview next cue",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "Control+ArrowUp",
    handler: ctx.previewReplayActiveCue,
    description: "Replay active preview cue",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  useKeyboardShortcut({
    key: "Control+ArrowDown",
    handler: ctx.previewTerminateTransitions,
    description: "Terminate preview transitions",
    componentId: props.panelId,
    group: "Sequence Editor",
  });

  const { cellProvider, drawTimingProgressDecoration, previewClockMs } =
    createSequenceEditorGridController({
      context: ctx,
      rows,
      columns,
      expandedCueUids,
      timingColumnDisplayUnits,
      defaultTimingDisplayUnit,
    });
  const { onCellEdited, onCellsEdited } = createSequenceEditorEditController({
    context: ctx,
    rows,
    columns,
    gridSelection,
  });

  /** Toggles expanded cue-part rows for the selected cue. */
  const toggleCueExpansion = (cueUid: string) => {
    setExpandedCueUids((previous) => {
      const next = new Set(previous);
      if (next.has(cueUid)) {
        next.delete(cueUid);
      } else {
        next.add(cueUid);
      }
      return next;
    });
  };

  /** Handles keyboard Delete after the data grid resolves its effective selection. */
  const onDelete = (selection: GridSelection): boolean =>
    clearTimingOverridesForSelection(selection);

  /** Opens the timing-column unit selector for the clicked data-grid cell. */
  const onCellContextMenu = (cell: Item, event: MouseEvent) => {
    const [col] = cell;
    const columnId = columns()[col]?.id;
    const affectedColumnIds = selectedTimeDisplayColumnIds({
      columns: columns(),
      clickedCell: cell,
      selection: gridSelection(),
      isTimeDisplayColumnId,
    });
    if (typeof columnId !== "string" || affectedColumnIds.length === 0) {
      return;
    }
    event.preventDefault();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: timeUnitContextMenuEntries({
        currentUnit: timingDisplayUnit(columnId),
        onSelect: (unit) =>
          setTimingColumnDisplayUnitsForColumns(affectedColumnIds, unit),
      }),
    });
  };

  return (
    <Switch>
      <Match when={ctx.loadingState().status === "loading"}>
        <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
          Loading sequence...
        </div>
      </Match>
      <Match when={ctx.loadingState().status === "not_found"}>
        <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
          Sequence not found
        </div>
      </Match>
      <Match when={ctx.loadingState().status === "loaded"}>
        <Show
          when={rows().length > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
              No cues in sequence
            </div>
          }
        >
          <div ref={rootRef} class="flex h-full min-h-0 flex-col">
            <SequenceEditorToolbar
              canOpenCue={() => selectedEditorRow()?.cue !== undefined}
              canDuplicateCue={canDuplicateSelectedCue}
              canDeleteRow={canDeleteSelectedEditorRow}
              deleteLabel={selectedDeleteLabel}
              canMoveUp={() => canMoveSelection(-1)}
              canMoveDown={() => canMoveSelection(1)}
              hasPreviewableCue={hasPreviewableCue}
              canJumpPreview={() =>
                selectedEditorRow()?.cue !== undefined &&
                !isMetaCueRow(selectedEditorRow() ?? {})
              }
              previewEnabled={ctx.previewEnabled}
              previewApplyTransitions={ctx.previewApplyTransitions}
              previewTrackValues={ctx.previewTrackValues}
              openCue={openSelectedCueEditor}
              duplicateCue={duplicateSelectedCue}
              deleteRow={deleteSelectedEditorRow}
              moveUp={() => moveSelectedCue(-1)}
              moveDown={() => moveSelectedCue(1)}
              previewBack={ctx.previewBack}
              previewGo={ctx.previewGo}
              previewJump={ctx.previewJumpToSelectedCue}
              togglePreview={() => ctx.setPreviewEnabled(!ctx.previewEnabled())}
              togglePreviewTransitions={() =>
                ctx.setPreviewApplyTransitions(!ctx.previewApplyTransitions())
              }
              togglePreviewTracking={() =>
                ctx.setPreviewTrackValues(!ctx.previewTrackValues())
              }
            />

            <TransitionScrubber
              playback={ctx.activePreviewPlayback()}
              cue={(() => {
                const cue = ctx
                  .cueRows()
                  .find((row) => row.cueUid === ctx.activePreviewCueUid())?.cue;
                return cue
                  ? buildSequencePreviewCue(
                      cue,
                      ctx.sequence()?.default_timing,
                      { applyTransitions: true },
                    )
                  : undefined;
              })()}
              enabled={ctx.previewEnabled() && ctx.previewApplyTransitions()}
            />

            <SequenceEditorGrid
              columns={columns()}
              rows={rows().length}
              cellProvider={cellProvider}
              cellDecorations={drawTimingProgressDecoration()}
              decorationInvalidateKey={previewClockMs()}
              onCellEdited={onCellEdited}
              onCellsEdited={onCellsEdited}
              onCellContextMenu={onCellContextMenu}
              onCellHovered={onCellHovered}
              onDelete={onDelete}
              onCellClicked={([col, row]) => {
                setLastClickedRow(row);
                const clickedRow = rows()[row];
                if (!clickedRow) return;
                setSelectedEditorTarget(editorTargetForRow(clickedRow));
                if (isSequenceSummaryRow(clickedRow)) {
                  ctx.selectCue(undefined);
                  return;
                }
                const columnId = columns()[col]?.id;
                if (
                  columnId === "cue_id" &&
                  clickedRow.rowKind === "cue" &&
                  (clickedRow.cue?.parts?.length ?? 0) > 0
                ) {
                  toggleCueExpansion(clickedRow.cueUid);
                }
                ctx.selectCue(clickedRow.cueUid);
              }}
              gridSelection={gridSelection()}
              onGridSelectionChange={handleGridSelectionChange}
              tooltip={conflictTooltip}
            />
          </div>
        </Show>
      </Match>
    </Switch>
  );
}
