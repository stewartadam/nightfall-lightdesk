// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  createKeyedDataGridCellProvider,
  type DataGridCellDecorationCallback,
  drawActiveCuePlayIcon,
  drawConflictWarningIcon,
} from "../../../components/widgets/data-grid";
import type { GridCell, GridColumn } from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { applyElementBackground } from "../../../lib/datagrid";
import {
  makeTimeCell,
  type RichTimeDisplayUnit,
} from "../../../lib/datagrid-rich-cells";
import { msToDuration } from "../../../lib/duration";
import type { DropdownGridCell } from "../../../lib/tanstack-dropdown-cell";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { activeInstances, layerStack } from "../../../state/appStores";
import {
  findTopmostSequencePlayback,
  normalizePlaybackUid,
  type PlaybackTransitionClock,
  playbackSequenceCueTransitionClocks,
  playbackSequenceCurrentCueUid,
  playbackSequenceNextCueUid,
  playbackTransitionClock,
  type TrackingFlagsGridCell,
  trackingFlagIds,
  trackingFlagsForMode,
  trackingFlagsSummary,
} from "../../cue-sequences";
import type { SequenceEditorContextType } from "../context/sequence-editor-context";
import {
  canEditTriggerDuration,
  cueIdDisplay,
  DEFAULT_SEQUENCE_TRACKING_FLAGS,
  drawActiveCueRowOutline,
  getTimeColumnProgress,
  INHERITED_TIMING_TEXT_COLOR,
  isComputedTimeColumnId,
  isMetaCueRow,
  isSequenceSummaryRow,
  isTimingColumnId,
  lookaheadIndicators,
  PART_ROW_BACKGROUND,
  SEQUENCE_DURATION_SUMMARY_ROW_KEY,
  type SequenceGridRow,
  type SequenceProgressContext,
  SUMMARY_ROW_BACKGROUND,
  timingColumnValue,
} from "../model/sequence-editor-model";

interface SequenceEditorGridControllerOptions {
  context: SequenceEditorContextType;
  rows: Accessor<SequenceGridRow[]>;
  columns: Accessor<GridColumn[]>;
  expandedCueUids: Accessor<Set<string>>;
  timingColumnDisplayUnits: Accessor<Record<string, RichTimeDisplayUnit>>;
  defaultTimingDisplayUnit: Accessor<RichTimeDisplayUnit>;
}

/** Owns sequence grid cell presentation and playback-progress decoration. */
export function createSequenceEditorGridController(
  options: SequenceEditorGridControllerOptions,
) {
  const workspaceActive = useWorkspaceActivity();
  const ctx = options.context;
  const rows = options.rows;
  const columns = options.columns;
  const expandedCueUids = options.expandedCueUids;
  const timingColumnDisplayUnits = options.timingColumnDisplayUnits;
  const defaultTimingDisplayUnit = options.defaultTimingDisplayUnit;
  const $activeInstances = useShallowStore(activeInstances);
  const $layerStack = useShallowStore(layerStack);
  const [previewClockMs, setPreviewClockMs] = createSignal(performance.now());

  /** Advances progress decoration while preview or live playback can change. */
  createEffect(() => {
    if (!workspaceActive()) return;
    if (!ctx.previewEnabled() && Object.keys($activeInstances()).length === 0) {
      return;
    }

    let frameId = 0;

    /** Queues the next animation-frame clock update for timing progress. */
    const tick = () => {
      setPreviewClockMs(performance.now());
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frameId));
  });

  /** Invalidates intrinsic sizing only when width-relevant sequence state changes. */
  const contentSizingKey = createMemo(() => ({
    rows: rows(),
    columns: columns(),
    expandedCueUids: expandedCueUids(),
    columnDisplayUnits: timingColumnDisplayUnits(),
    defaultDisplayUnit: defaultTimingDisplayUnit(),
    sequence: ctx.sequence(),
  }));

  /** Builds keyed cell content from current sequence rows and playback state. */
  const cellProvider = createMemo(() => {
    const nowMs = previewClockMs();
    const columnDisplayUnits = timingColumnDisplayUnits();
    const defaultDisplayUnit = defaultTimingDisplayUnit();
    const expanded = expandedCueUids();
    const previewEnabled = ctx.previewEnabled();
    const previewApplyTransitions = ctx.previewApplyTransitions();
    const previewStartedAtMs = ctx.previewStartedAtMs();
    const sequence = ctx.sequence();
    const releaseCueUid = sequence?.release_cue.identifiers.uid;
    const inheritedTrackingSummary = trackingFlagsSummary(
      trackingFlagsForMode(
        sequence?.tracking_mode,
        DEFAULT_SEQUENCE_TRACKING_FLAGS,
      ),
    );
    const playback = findTopmostSequencePlayback(
      $activeInstances(),
      $layerStack(),
      ctx.sequenceUid,
    );
    const instanceClock =
      playback?.is_preview && !previewApplyTransitions
        ? undefined
        : playbackTransitionClock(playback, Date.now());
    const previewClock =
      previewEnabled &&
      previewApplyTransitions &&
      previewStartedAtMs !== undefined
        ? ({
            phase: "in",
            elapsedSeconds: Math.max(0, (nowMs - previewStartedAtMs) / 1000),
          } satisfies PlaybackTransitionClock)
        : undefined;
    const transitionClock = instanceClock ?? previewClock;
    const activeCueUidRaw =
      transitionClock?.phase === "out"
        ? releaseCueUid
        : (playbackSequenceCurrentCueUid(playback) ??
          ctx.activePreviewCueUid());
    const activeCueUid =
      activeCueUidRaw !== undefined
        ? normalizePlaybackUid(activeCueUidRaw)
        : undefined;
    const cueClocks = { ...playbackSequenceCueTransitionClocks(playback) };
    if (activeCueUid !== undefined && transitionClock !== undefined) {
      cueClocks[activeCueUid] ??= transitionClock;
    }
    const progressContext: SequenceProgressContext = {
      transitionClock,
      cueClocks,
      activeCueUid,
      afterDelayCueUid:
        transitionClock?.phase === "in"
          ? playbackSequenceNextCueUid(playback)
          : undefined,
    };

    return createKeyedDataGridCellProvider({
      rows: rows(),
      columns: columns(),
      contentSizingKey: contentSizingKey(),
      rowKey: (row) =>
        row.rowKind === "summary"
          ? SEQUENCE_DURATION_SUMMARY_ROW_KEY
          : row.rowKind === "part"
            ? `${row.cueUid}:part:${row.partId ?? row.partIndex ?? ""}`
            : `${row.cueUid}:cue`,
      columnKey: (column) => String(column.id),
      getCellContent: ({ row: item, column }): GridCell => {
        const columnId = column.id;
        const isPartReadOnlyColumn =
          item.rowKind === "part" &&
          (columnId === "trigger" || columnId === "after_delay");
        const isMetaCueReadOnlyColumn =
          isMetaCueRow(item) &&
          (columnId === "trigger" ||
            (columnId === "after_delay" && !canEditTriggerDuration(item)));
        const isFirstCueTriggerReadOnlyColumn =
          item.isFirstSequenceCue && columnId === "trigger";
        const isDisabledWrapDelayColumn =
          item.isFirstSequenceCue &&
          !item.isWrapDelayCue &&
          columnId === "after_delay";
        const isEditable =
          !item.isMissing &&
          !isSequenceSummaryRow(item) &&
          columnId !== "cue_id" &&
          !isComputedTimeColumnId(columnId) &&
          !isPartReadOnlyColumn &&
          !isMetaCueReadOnlyColumn &&
          !isFirstCueTriggerReadOnlyColumn &&
          !isDisabledWrapDelayColumn;
        const isTrackingEditable = isEditable && !item.isSetupCue;

        if (isSequenceSummaryRow(item)) {
          const computedTimeSeconds = isComputedTimeColumnId(columnId)
            ? item[columnId === "start_time" ? "startTime" : "duration"]
            : undefined;
          const cell: GridCell =
            computedTimeSeconds !== undefined
              ? makeTimeCell(
                  {
                    value: msToDuration(computedTimeSeconds * 1000),
                    displayUnit:
                      typeof columnId === "string"
                        ? (columnDisplayUnits[columnId] ?? defaultDisplayUnit)
                        : defaultDisplayUnit,
                    minMs: 0,
                    placeholder: "1s",
                    clearable: false,
                  },
                  {
                    readonly: true,
                    allowOverlay: false,
                  },
                )
              : {
                  kind: GridCellKind.Text,
                  data: columnId === "label" ? item.label : "",
                  displayData: columnId === "label" ? item.label : "",
                  allowOverlay: false,
                };
          return applyElementBackground(cell, true, SUMMARY_ROW_BACKGROUND);
        }

        if (columnId === "cue_id") {
          return applyElementBackground(
            {
              kind: GridCellKind.Text,
              data: item.cueId,
              displayData: cueIdDisplay(item, expanded),
              allowOverlay: false,
            },
            item.rowKind === "part",
            PART_ROW_BACKGROUND,
          );
        }

        if (columnId === "label") {
          return applyElementBackground(
            {
              kind: GridCellKind.Text,
              data: item.label,
              displayData:
                item.rowKind === "part" ? `    ${item.label}` : item.label,
              allowOverlay: isEditable,
            },
            item.rowKind === "part",
            PART_ROW_BACKGROUND,
          );
        }

        if (columnId === "trigger") {
          if (item.rowKind === "part") {
            return applyElementBackground(
              {
                kind: GridCellKind.Text,
                data: "Part",
                displayData: "Part",
                allowOverlay: false,
              },
              true,
              PART_ROW_BACKGROUND,
            );
          }
          if (isMetaCueRow(item)) {
            return {
              kind: GridCellKind.Text,
              data: item.trigger,
              displayData: item.trigger,
              contentAlign: "left",
              allowOverlay: false,
            };
          }
          if (item.isFirstSequenceCue) {
            return {
              kind: GridCellKind.Text,
              data: item.trigger,
              displayData: item.trigger,
              contentAlign: "left",
              allowOverlay: false,
            };
          }

          const cell: DropdownGridCell = {
            kind: GridCellKind.Custom,
            data: {
              kind: "dropdown-cell",
              value: item.cue?.trigger.type ?? null,
              allowedValues: [
                { value: "Manual", label: "Manual" },
                { value: "FollowPrevious", label: "Follow Previous" },
                { value: "AfterDelay", label: "After Delay" },
                { value: "At", label: "At" },
              ],
            },
            readonly: !isEditable,
            allowOverlay: isEditable,
          };
          return cell;
        }

        if (columnId === "tracking") {
          const trackingMode =
            item.rowKind === "cue" || item.partId === 0
              ? item.trackingMode?.type === "Inherit"
                ? "Inherit"
                : "Flags"
              : undefined;
          const cell: TrackingFlagsGridCell = {
            kind: GridCellKind.Custom,
            data: {
              kind: "tracking-flags-cell",
              selectedIds: trackingFlagIds(item.trackingFlags),
              trackingMode,
              inheritedSummary:
                trackingMode === "Inherit"
                  ? inheritedTrackingSummary
                  : undefined,
            },
            copyData:
              trackingMode === "Inherit"
                ? "Inherit"
                : trackingFlagsSummary(item.trackingFlags),
            readonly: !isTrackingEditable,
            allowOverlay: isTrackingEditable,
          };
          return applyElementBackground(
            cell,
            item.rowKind === "part",
            PART_ROW_BACKGROUND,
          );
        }

        if (columnId === "lookahead") {
          const cell: GridCell = {
            kind: GridCellKind.Boolean,
            data: item.lookaheadOwnEnabled,
            copyData: item.lookaheadOwnEnabled ? "Lookahead" : "",
            readonly: !isEditable,
            allowOverlay: false,
            stateIndicators: lookaheadIndicators(item),
            stateIndicatorPlacement: "floating-end",
          };
          return applyElementBackground(
            cell,
            item.rowKind === "part",
            PART_ROW_BACKGROUND,
          );
        }

        if (isComputedTimeColumnId(columnId)) {
          const computedTimeSeconds =
            columnId === "start_time" ? item.startTime : item.duration;
          if (computedTimeSeconds === undefined) {
            return applyElementBackground(
              {
                kind: GridCellKind.Text,
                data: "",
                displayData: "",
                allowOverlay: false,
              },
              item.rowKind === "part",
              PART_ROW_BACKGROUND,
            );
          }

          const cell = makeTimeCell(
            {
              value: msToDuration(computedTimeSeconds * 1000),
              displayUnit: columnDisplayUnits[columnId] ?? defaultDisplayUnit,
              minMs: 0,
              placeholder: "1s",
              clearable: false,
            },
            {
              readonly: true,
              allowOverlay: false,
            },
          );
          return applyElementBackground(
            cell,
            item.rowKind === "part",
            PART_ROW_BACKGROUND,
          );
        }

        const timingSeconds = isTimingColumnId(columnId)
          ? timingColumnValue(item, columnId)
          : item.afterDelay;

        if (item.rowKind === "part" && columnId === "after_delay") {
          return applyElementBackground(
            {
              kind: GridCellKind.Text,
              data: "",
              displayData: "",
              allowOverlay: false,
            },
            true,
            PART_ROW_BACKGROUND,
          );
        }

        const cell: GridCell = makeTimeCell(
          {
            value: msToDuration(timingSeconds * 1000),
            displayUnit:
              typeof columnId === "string"
                ? (columnDisplayUnits[columnId] ?? defaultDisplayUnit)
                : defaultDisplayUnit,
            minMs: 0,
            placeholder: "1s",
            clearable: isTimingColumnId(columnId),
            backgroundFill: getTimeColumnProgress(
              item,
              columnId,
              progressContext,
            ),
            backgroundFillColor: "rgba(59, 130, 246, 0.48)",
          },
          {
            readonly: !isEditable,
            allowOverlay: isEditable,
          },
        );

        const themedCell =
          isTimingColumnId(columnId) && item.inheritedTimings[columnId]
            ? {
                ...cell,
                themeOverride: {
                  ...cell.themeOverride,
                  textDark: INHERITED_TIMING_TEXT_COLOR,
                },
              }
            : cell;

        return applyElementBackground(
          themedCell,
          item.rowKind === "part",
          PART_ROW_BACKGROUND,
        );
      },
    });
  });

  /** Builds canvas decorations for active, previewed, and conflicted cue rows. */
  const drawTimingProgressDecoration = createMemo(() => {
    const dataRows = rows();
    const dataColumns = columns();
    const previewEnabled = ctx.previewEnabled();
    previewClockMs();
    const playback = findTopmostSequencePlayback(
      $activeInstances(),
      $layerStack(),
      ctx.sequenceUid,
    );
    const instanceClock = playbackTransitionClock(playback, Date.now());
    const releaseCueUid = ctx.sequence()?.release_cue.identifiers.uid;
    const activeCueUid =
      instanceClock?.phase === "out"
        ? releaseCueUid
        : (playbackSequenceCurrentCueUid(playback) ??
          ctx.activePreviewCueUid());
    const materializedActiveCueUidRaw =
      instanceClock?.phase === "out"
        ? releaseCueUid
        : playbackSequenceCurrentCueUid(playback);
    const materializedActiveCueUid =
      materializedActiveCueUidRaw !== undefined
        ? normalizePlaybackUid(materializedActiveCueUidRaw)
        : undefined;

    const drawDecoration: DataGridCellDecorationCallback = (args) => {
      const columnId = dataColumns[args.col]?.id;
      const row = dataRows[args.row];
      if (!row || !columnId) return;

      if (
        columnId === "cue_id" &&
        row.rowKind === "cue" &&
        !row.isMissing &&
        normalizePlaybackUid(row.cueUid) === materializedActiveCueUid
      ) {
        drawActiveCuePlayIcon(args);
      }

      if (columnId === "label" && row.hasPartConflict) {
        drawConflictWarningIcon(args);
      }

      if (previewEnabled && row.cueUid === activeCueUid && !row.isMissing) {
        drawActiveCueRowOutline(
          args,
          args.col === 0,
          args.col === dataColumns.length - 1,
        );
      }
    };

    return drawDecoration;
  });

  return {
    cellProvider,
    drawTimingProgressDecoration,
    previewClockMs,
  };
}
