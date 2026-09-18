// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type {
  CellClickedEventArgs,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import type { RichTimeDisplayUnit } from "../../../lib/datagrid-rich-cells";
import {
  registerComponentFocus,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { timeDisplayUnitFromPreference } from "../../../lib/time-display-units";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { dockApi } from "../../../state/appStores";
import { $settings } from "../../../state/settings";
import type * as types from "../../../types";
import { TransitionScrubber } from "../../cue-sequences";
import { usePropertiesInspector } from "../../property-inspector";
import { CueEditorGrid } from "../components/cue-editor-grid";
import { CueEditorToolbar } from "../components/cue-editor-toolbar";
import CueProperties from "../components/cue-properties";
import {
  CueEditorContextProvider,
  type CueEditorContextType,
  formatCueEditorTitle,
  useCueEditorContext,
} from "../context/cue-editor-context";

import {
  type CueCellTooltipState,
  type CueGridColumn,
  cueValueConflictTooltip,
  type DisplayMode,
  type TrackedCueSource,
} from "../model/cue-editor-model";
import { createCueEditorEditController } from "./cue-editor-edit-controller";
import { createCueEditorGridController } from "./cue-editor-grid-controller";
import { createCueEditorSelectionController } from "./cue-editor-selection-controller";

const log = getLogger(import.meta.url);

/** Coordinates cue grid state, editing commands, and feature-owned presentation. */
export function CueEditorController(props: {
  panelId: string;
  contextValue: CueEditorContextType;
}) {
  let rootRef!: HTMLDivElement;
  const workspaceActive = useWorkspaceActivity();
  const ctx = useCueEditorContext();
  const $dockApi = useStore(dockApi);
  const settings = useStore($settings);
  const [displayMode, setDisplayModeSignal] = createSignal<DisplayMode>(
    ctx.isReleaseCue ? "timings" : "values",
  );
  const [showTrackedValues, setShowTrackedValues] = createSignal(false);
  const [gridSelection, setGridSelection] = createSignal<
    GridSelection | undefined
  >(undefined);
  const [gridKeyboardActive, setGridKeyboardActive] = createSignal(false);
  const [lastClickedCell, setLastClickedCell] = createSignal<Item | undefined>(
    undefined,
  );
  const [expandedFixtures, setExpandedFixtures] = createSignal<Set<string>>(
    new Set(),
  );
  const [timingColumnDisplayUnits, setTimingColumnDisplayUnits] = createSignal<
    Record<string, RichTimeDisplayUnit>
  >({});
  const defaultTimingDisplayUnit = createMemo(() =>
    timeDisplayUnitFromPreference(settings().time_display_preference),
  );
  const [cueGridRevision, setCueGridRevision] = createSignal(0);
  const [cellTooltip, setCellTooltip] = createSignal<CueCellTooltipState>();
  let cellTooltipTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let cellTooltipId = 0;

  /** Clears any pending or visible cue cell tooltip. */
  const clearCellTooltip = () => {
    if (cellTooltipTimeoutId !== undefined) {
      clearTimeout(cellTooltipTimeoutId);
      cellTooltipTimeoutId = undefined;
    }
    setCellTooltip(undefined);
  };

  /** Returns the conflict tooltip content for one grid cell, when applicable. */
  const conflictTooltipContentForCell = (cell: Item): string | undefined => {
    if (displayMode() !== "values") return undefined;
    const [col, row] = cell;
    const rowData = flatRows()[row];
    const columnId = columns()[col]?.id;
    if (!rowData || typeof columnId !== "string") return undefined;
    const conflict = rowData.valueConflicts.get(columnId);
    return conflict ? cueValueConflictTooltip(conflict) : undefined;
  };

  /** Returns the tracked source displayed by one value cell. */
  const trackedSourceForCell = (cell: Item): TrackedCueSource | undefined => {
    if (displayMode() !== "values" || !showTrackedValues()) return undefined;
    const [col, row] = cell;
    const rowData = flatRows()[row];
    const column = columns()[col] as CueGridColumn | undefined;
    const attr =
      column?.cueColumnKind === "value" ? column.cueAttribute : undefined;
    if (!rowData || !attr) return undefined;
    if (
      rowData.attributes.release.has(attr) ||
      rowData.attributes.rel[attr] ||
      rowData.attributes.abs[attr]
    ) {
      return undefined;
    }
    return rowData.trackedAttributes[attr]
      ? rowData.trackedAttributeSources[attr]
      : undefined;
  };

  /** Returns the tracked source tooltip content for one grid cell. */
  const trackedTooltipContentForCell = (cell: Item): string | undefined => {
    const source = trackedSourceForCell(cell);
    return source
      ? `Tracked from ${source.label}. Alt-click to open.`
      : undefined;
  };

  /** Returns the lookahead source displayed by one value cell. */
  const lookaheadSourceForCell = (cell: Item): TrackedCueSource | undefined => {
    if (displayMode() !== "values" || !showTrackedValues()) return undefined;
    const [col, row] = cell;
    const rowData = flatRows()[row];
    const column = columns()[col] as CueGridColumn | undefined;
    const attr =
      column?.cueColumnKind === "value" ? column.cueAttribute : undefined;
    if (!rowData || !attr) return undefined;
    if (
      rowData.attributes.release.has(attr) ||
      rowData.attributes.rel[attr] ||
      rowData.attributes.abs[attr]
    ) {
      return undefined;
    }
    return rowData.lookaheadAttributes[attr]
      ? rowData.lookaheadAttributeSources[attr]
      : undefined;
  };

  /** Returns the lookahead source tooltip content for one grid cell. */
  const lookaheadTooltipContentForCell = (cell: Item): string | undefined => {
    const source = lookaheadSourceForCell(cell);
    return source ? `Lookahead from ${source.label}.` : undefined;
  };

  /** Schedules a delayed tooltip for conflicted or tracked cue value cells. */
  const onCellHovered = (cell: Item | undefined, element?: HTMLElement) => {
    clearCellTooltip();
    if (!cell || !element) return;

    const content =
      conflictTooltipContentForCell(cell) ??
      lookaheadTooltipContentForCell(cell) ??
      trackedTooltipContentForCell(cell);
    if (!content) return;

    cellTooltipTimeoutId = setTimeout(() => {
      setCellTooltip({
        id: ++cellTooltipId,
        content,
        anchorRect: element.getBoundingClientRect(),
      });
      cellTooltipTimeoutId = undefined;
    }, 500);
  };

  /** Hides pending cell hover UI when the editor unmounts. */
  onCleanup(clearCellTooltip);

  /** Changes display mode while keeping release cue editors timing-only. */
  const setDisplayMode = (mode: DisplayMode) => {
    if (ctx.isReleaseCue && mode === "values") return;
    setDisplayModeSignal(mode);
  };

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

  /** Returns the focusable cue editor grid wrapper, when it is mounted. */
  const cueGridElement = (): HTMLElement | undefined =>
    rootRef?.querySelector<HTMLElement>('[role="grid"]') ?? undefined;

  /** Returns whether a key should be forwarded to the keyboard-active cue grid. */
  const isCueGridForwardKey = (event: KeyboardEvent): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key.length === 1) return true;
    return (
      event.key === "Enter" ||
      event.key === "Escape" ||
      event.key === "Tab" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === "PageUp" ||
      event.key === "PageDown"
    );
  };

  /** Replays a keyboard event against the cue grid after focus escaped the panel. */
  const forwardKeyboardEventToCueGrid = (event: KeyboardEvent): boolean => {
    const grid = cueGridElement();
    if (!grid || !isCueGridForwardKey(event)) return false;
    const forwardedEvent = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    event.stopPropagation();
    grid.focus();
    window.setTimeout(() => {
      grid.focus();
      grid.dispatchEvent(forwardedEvent);
    }, 0);
    return true;
  };

  /** Publishes an edited cue through context and invalidates local async row derivation. */
  const commitCueUpdate = (updatedCue: types.Cue) => {
    setCueGridRevision((revision) => revision + 1);
    ctx.commitEditedCue(updatedCue);
  };

  /** Persists live-projected release cue rows when the owning sequence changes. */
  createEffect(() => {
    const projectedCue = ctx.releaseCueProjectionUpdate();
    if (!projectedCue) return;
    commitCueUpdate(projectedCue);
  });

  /** Logs editor component mounting for targeted diagnostics. */
  onMount(() => {
    log.trace("mounting CueEditor");
  });

  // Share the editor context with Properties while this workspace owns the inspector.
  usePropertiesInspector(
    props.panelId,
    ctx.label,
    () => (
      <CueEditorContextProvider value={props.contextValue}>
        <CueProperties />
      </CueEditorContextProvider>
    ),
    { priority: 10 },
  );

  const {
    allColumns,
    canShowEmptyCueToolbar,
    cellProvider,
    columns,
    flatRows,
  } = createCueEditorGridController({
    panelId: props.panelId,
    context: ctx,
    displayMode,
    showTrackedValues,
    expandedFixtures,
    cueGridRevision,
    timingColumnDisplayUnits,
    defaultTimingDisplayUnit,
  });

  /** Applies one grid edit to an already-copied cue without committing it. */
  const {
    clearTimingOverridesForSelection,
    inlineEditTooltip,
    onCellEdited,
    onCellsEdited,
  } = createCueEditorEditController({
    context: ctx,
    displayMode,
    gridSelection,
    lastClickedCell,
    flatRows,
    columns,
    commitCueUpdate,
  });

  /** Returns whether a grid selection range contains the given cell. */
  const {
    clearAssertionsForSelection,
    onCellContextMenu,
    onColumnHeaderContextMenu,
  } = createCueEditorSelectionController({
    context: ctx,
    displayMode,
    gridSelection,
    lastClickedCell,
    flatRows,
    columns,
    commitCueUpdate,
    clearTimingOverridesForSelection,
    timingDisplayUnit,
    setTimingColumnDisplayUnitsForColumns,
  });
  const handlePriorityKeyDown = (event: KeyboardEvent) => {
    if (!workspaceActive()) return;
    if (!rootRef) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    const targetInsidePanel = rootRef.contains(target);
    if (!targetInsidePanel && !gridKeyboardActive()) return;

    const targetIsEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (!targetInsidePanel && targetIsEditable) return;
    const editingTextInput = targetInsidePanel && targetIsEditable;
    const targetInsideGrid =
      target instanceof Element &&
      (target.closest('[data-grid-kind="tanstack"]') !== null ||
        target
          .closest('[role="grid"]')
          ?.querySelector('[data-grid-kind="tanstack"]') !== null);

    if (
      !targetInsidePanel &&
      gridKeyboardActive() &&
      forwardKeyboardEventToCueGrid(event)
    ) {
      return;
    }

    if (
      !editingTextInput &&
      !targetInsideGrid &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.key === "Delete" || event.key === "Backspace")
    ) {
      const selection = gridSelection();
      if (
        !clearAssertionsForSelection(
          selection,
          event.shiftKey ? "parent-and-children" : "parent",
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }
  };

  /** Tracks whether subsequent keyboard events should be treated as grid commands. */
  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!rootRef) return;
    const target = event.target;
    setGridKeyboardActive(target instanceof Node && rootRef.contains(target));
  };

  /** Registers focus and document-level keyboard handlers for this editor panel. */
  onMount(() => {
    const unregisterFocus = registerComponentFocus(props.panelId, rootRef);
    document.addEventListener("pointerdown", handleDocumentPointerDown, {
      capture: true,
    });
    document.addEventListener("keydown", handlePriorityKeyDown, {
      capture: true,
    });
    onCleanup(() => {
      unregisterFocus();
      document.removeEventListener("pointerdown", handleDocumentPointerDown, {
        capture: true,
      });
      document.removeEventListener("keydown", handlePriorityKeyDown, {
        capture: true,
      });
    });
  });

  /** Lets grid Delete clear cue assertions and timing overrides. */
  const onDelete = (
    selection: GridSelection,
    context?: { shiftKey: boolean },
  ): GridSelection | false =>
    clearAssertionsForSelection(
      selection,
      context?.shiftKey ? "parent-and-children" : "parent",
    )
      ? selection
      : false;

  /** Opens or focuses the cue editor for a tracked value source. */
  const openTrackedValueSource = (source: TrackedCueSource) => {
    const api = $dockApi();
    if (!api) return;

    const panelId = source.setupSequenceUid
      ? `setup-cue-editor-${source.setupSequenceUid}-p${source.partId}`
      : `cue-editor-${source.cueUid}-p${source.partId}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: formatCueEditorTitle({
        cueId: source.cueId,
        sequenceId: source.sequenceId,
        partId: source.partId,
        hasAdditionalParts: source.hasAdditionalParts,
        isSetupCue: source.setupSequenceUid !== undefined,
      }),
      params: {
        initialCueUid: source.cueUid,
        initialPartId: source.partId,
        initialSequenceId: source.sequenceId,
        initialSequenceUid: source.sequenceUid,
        initialSetupSequenceUid: source.setupSequenceUid,
      },
    });
  };

  /** Handles row expansion clicks and remembers the last active grid cell. */
  const onCellClicked = (cell: Item, event: CellClickedEventArgs) => {
    const altKey = (event as CellClickedEventArgs & { altKey?: boolean })
      .altKey;
    if (altKey && displayMode() === "values") {
      const source = trackedSourceForCell(cell);
      if (source) {
        openTrackedValueSource(source);
        setLastClickedCell(cell);
        setGridKeyboardActive(true);
        return;
      }
    }

    const [col, row] = cell;
    const rowData = flatRows()[row];
    const colId = columns()[col]?.id;
    if (colId === "id" && rowData?.type === "parent" && rowData.hasElements) {
      setExpandedFixtures((prev) => {
        const next = new Set(prev);
        if (next.has(rowData.expansionKey)) {
          next.delete(rowData.expansionKey);
        } else {
          next.add(rowData.expansionKey);
        }
        return next;
      });
    }
    setLastClickedCell(cell);
    setGridKeyboardActive(true);
  };

  /** Tracks grid selection changes that should leave grid keyboard commands active. */
  const onGridSelectionChanged = (selection: GridSelection | undefined) => {
    setGridSelection(selection);
    setGridKeyboardActive(true);
  };

  useKeyboardShortcut({
    key: "Control+ArrowUp",
    handler: ctx.previewReplayActiveCue,
    description: "Replay cue preview",
    componentId: props.panelId,
    group: "Cue Editor",
  });

  useKeyboardShortcut({
    key: "Control+ArrowDown",
    handler: ctx.previewTerminateTransitions,
    description: "Terminate cue preview transitions",
    componentId: props.panelId,
    group: "Cue Editor",
  });

  return (
    <div
      ref={rootRef}
      class="flex flex-col h-full"
      data-cue-editor-panel-id={props.panelId}
      data-panel-id={props.panelId}
    >
      <Switch>
        <Match when={ctx.loadingState().status === "loading"}>
          <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            Loading cue data...
          </div>
        </Match>
        <Match when={ctx.loadingState().status === "not_found"}>
          <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            Cue {ctx.cueUid} not found
          </div>
        </Match>
        <Match when={ctx.loadingState().status === "loaded"}>
          <Show
            when={flatRows().length > 0 || canShowEmptyCueToolbar()}
            fallback={
              <div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
                No fixture values in cue p{ctx.partId}
              </div>
            }
          >
            <div class="flex h-full min-h-0 flex-col overflow-hidden">
              <CueEditorToolbar
                panelId={props.panelId}
                columns={allColumns}
                displayMode={displayMode}
                isReleaseCue={ctx.isReleaseCue}
                showTrackedValues={showTrackedValues}
                previewActive={ctx.previewActive}
                previewApplyTransitions={ctx.previewApplyTransitions}
                setDisplayMode={setDisplayMode}
                toggleTrackedValues={() =>
                  setShowTrackedValues((shown) => !shown)
                }
                togglePreview={() => ctx.setPreviewActive(!ctx.previewActive())}
                togglePreviewTransitions={() =>
                  ctx.setPreviewApplyTransitions(!ctx.previewApplyTransitions())
                }
              />

              <TransitionScrubber
                playback={ctx.activePreviewPlayback()}
                cue={ctx.cue()}
                enabled={ctx.previewActive() && ctx.previewApplyTransitions()}
              />

              <Show
                when={flatRows().length > 0}
                fallback={
                  <div class="flex min-h-0 flex-1 items-center justify-center text-gray-500 dark:text-gray-400">
                    No fixture values in cue p{ctx.partId}
                  </div>
                }
              >
                <CueEditorGrid
                  columns={columns()}
                  rows={flatRows().length}
                  cellProvider={cellProvider}
                  onCellEdited={onCellEdited}
                  onCellsEdited={onCellsEdited}
                  inlineEditTooltip={inlineEditTooltip}
                  onCellClicked={onCellClicked}
                  onCellHovered={onCellHovered}
                  onCellContextMenu={onCellContextMenu}
                  onColumnHeaderContextMenu={onColumnHeaderContextMenu}
                  onDelete={onDelete}
                  gridSelection={gridSelection()}
                  onGridSelectionChange={onGridSelectionChanged}
                  tooltip={cellTooltip}
                />
              </Show>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
