// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import { deleteCue, sendCueUpdate } from "../../../lib/cue-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import {
  serializeTimelineInsertDragPayload,
  TIMELINE_INSERT_DRAG_MIME,
} from "../../../lib/timeline-insert-drag";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { cues, dockApi, pushToast, sequences } from "../../../state/appStores";
import type { Cue, Sequence } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { formatCueEditorTitle } from "../context/cue-editor-context";
import {
  buildCueGridOrder,
  buildCueGroups,
  buildCueListRows,
  type CueListCueRow,
  type CueListDisplayRow,
  type CueListGroupRow,
  cueGroupKeyForUid,
  groupCueData,
} from "../model/cue-list-model";

export interface CueListControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns cue-list CRUD, selection, grouped projection, and panel shortcuts. */
export function createCueListController(props: CueListControllerProps) {
  let panelRootRef: HTMLDivElement | undefined;
  const $cues = useShallowStore(cues);
  const $sequences = useShallowStore(sequences);
  const $dockApi = useStore(dockApi);
  const panelId = props.initialPanelId ?? props.id;
  const crud = createCrudListState<CueListDisplayRow>({
    panelId,
    searchLabel: "Search cues",
    viewModeKey: "cue-list",
    orderedUids: (): readonly string[] => cueGridOrder(),
  });
  const {
    search,
    selectionMode,
    viewMode,
    setViewMode,
    setSelectionModeEnabled,
    selectedCount,
    clearSelection,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    labelEditRequest,
    setLabelEditRequest,
    listSelectionRequest,
    setListSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    handleToggleSelectionMode,
    handleEscape,
    gridDragSelection,
    gridClickSelection,
  } = crud;
  const selectedCueUids = crud.selectedUids;
  const setSelectedCueUids = crud.setSelectedUids;
  const selectedCueUidSet = crud.selectedUidSet;
  const [activeCueListRow, setActiveCueListRow] =
    createSignal<CueListDisplayRow | null>(null);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = createSignal<string[]>(
    [],
  );
  /** Returns the single cue exposed to Properties, or null for other selections. */
  const propertiesCue = createMemo(() => {
    if (selectedCount() !== 1) return null;
    const [cueUid] = selectedCueUids();
    return cueUid ? ($cues()[cueUid] ?? null) : null;
  });

  usePropertiesInspector(
    panelId,
    "Cue",
    () => (
      <CrudLabelProperties
        entry={propertiesCue()}
        entityName="Cue"
        getId={(cue) => cue.identifiers.id}
        getLabel={(cue) => cue.identifiers.label}
        onLabelCommit={(cue, label) => updateCueLabel(cue, label)}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Stores a cue label change while preserving cue identity and timing data. */
  const updateCueLabel = (cue: Cue, label: string) => {
    if (label === cue.identifiers.label) return;
    sendCueUpdate({
      ...cue,
      identifiers: {
        ...cue.identifiers,
        label,
      },
    });
  };

  /** Requests inline editing for a cue row label cell. */
  const requestCueLabelEdit = (cue: Cue) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(cue.identifiers.uid.toString());
      return;
    }
    setCollapsedGroupKeys([]);
    const startEdit = () => {
      const row = cueListRows().find(
        (candidate) =>
          candidate.rowKind === "cue" &&
          candidate.cueUid === cue.identifiers.uid.toString(),
      );
      if (!row) return;
      setLabelEditRequest({ row, columnId: "label", requestId: Date.now() });
    };
    startEdit();
  };

  /** Toggles one cue UID within the current selection. */
  const toggleSelection = (cueUid: string) => {
    setSelectedCueUids((current) => {
      const next = new Set(current);
      if (next.has(cueUid)) {
        next.delete(cueUid);
      } else {
        next.add(cueUid);
      }
      return Array.from(next);
    });
  };

  /** Focuses or opens an editor for one cue and its owning sequence. */
  const openCueEditor = (cueUid: string) => {
    const api = $dockApi();
    if (!api) return;

    const cueMap = $cues();
    const cue = cueMap[cueUid];
    if (!cue) return;
    const sequence = Object.values($sequences()).find((entry) =>
      entry.steps.includes(cueUid),
    );

    const panelId = `cue-list-panel-${cueUid}`; // FIXME: find way to avoid hardcoded panel name string

    // Focus an existing panel if its already open, or open it if not
    const panel = api.getPanel(panelId);
    if (panel) {
      return panel.focus();
    }
    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: formatCueEditorTitle({
        cueId: cue.identifiers.id,
        sequenceId: sequence?.identifiers.id,
        partId: 0,
        hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
      }),
      params: {
        initialCueUid: cueUid,
        initialSequenceId: sequence?.identifiers.id,
        initialSequenceUid: sequence?.identifiers.uid,
      },
    });
  };

  /** Opens or selects a cue card according to the current selection mode. */
  const handleCueItemClick = (cueUid: string) => {
    if (isDeleteModalOpen()) return;
    if (selectionMode()) {
      toggleSelection(cueUid);
      return;
    }
    openCueEditor(cueUid);
  };

  /** Publishes a cue drag payload for timeline insertion. */
  const handleDragStart = (event: DragEvent, cue: Cue) => {
    if (selectionMode()) return;
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(
      TIMELINE_INSERT_DRAG_MIME,
      serializeTimelineInsertDragPayload({
        source: "cue",
        actionType: "FireCue",
        targetUid: cue.identifiers.uid,
        targetLabel: `Cue ${cue.identifiers.id}: ${cue.identifiers.label}`,
      }),
    );
    event.dataTransfer.effectAllowed = "copy";
  };

  /** Resolves the sequence and numeric cue IDs required by deletion commands. */
  const resolveCueDeleteTarget = (cueUid: string) => {
    const cueMap = $cues();
    const sequenceMap = $sequences();
    const cue = cueMap[cueUid];
    if (!cue) return null;

    const sequence = Object.values(sequenceMap).find((entry) =>
      entry.steps.includes(cueUid),
    );
    if (!sequence) return null;

    return {
      sequenceId: sequence.identifiers.id,
      cueId: cue.identifiers.id,
    };
  };

  /** Opens the sole selected cue for editing. */
  const handleEditSelected = () => {
    if (isDeleteModalOpen()) return;
    const [selectedCueUid] = selectedCueUids();
    if (!selectedCueUid) return;
    openCueEditor(selectedCueUid);
    setSelectionModeEnabled(false);
  };

  /** Applies Enter to the active group row or selected cue. */
  const handleEnter = () => {
    if (viewMode() === "list") {
      const activeRow = activeCueListRow();
      if (activeRow?.rowKind === "group") {
        toggleGroupCollapsed(activeRow.groupKey);
        return;
      }
    }
    handleEditSelected();
  };

  /** Opens deletion confirmation when at least one cue is selected. */
  const handleDeleteSelected = () => {
    const selected = selectedCueUids();
    if (selected.length === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Selects a context-clicked cue unless it already belongs to the selection. */
  const selectForContextMenu = (cueUid: string) => {
    if (selectedCueUidSet().has(cueUid)) return;
    setSelectedCueUids([cueUid]);
  };

  /** Opens cue editing, renaming, and deletion context actions. */
  const openCueContextMenu = (cue: Cue, x: number, y: number) => {
    const cueUid = cue.identifiers.uid.toString();
    selectForContextMenu(cueUid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-cue",
          label: "Open Cue",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          onSelect: () => openCueEditor(cueUid),
        },
        {
          id: "rename-cue",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestCueLabelEdit(cue),
        },
        { id: "cue-menu-separator", type: "separator" },
        {
          id: "delete-cue",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Cues`
              : "Delete Cue",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Opens collapse or expand context actions for a cue group. */
  const openCueGroupContextMenu = (
    row: CueListGroupRow,
    x: number,
    y: number,
  ) => {
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "toggle-cue-group",
          label: row.isCollapsed ? "Expand Group" : "Collapse Group",
          onSelect: () => toggleGroupCollapsed(row.groupKey),
        },
      ],
    });
  };

  /** Handles list-grid Enter before the global panel shortcut registry. */
  const handlePanelKeyDownCapture = (event: KeyboardEvent) => {
    if (viewMode() !== "list") return;
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      handleEnter();
    }
  };

  /** Deletes resolvable selected cues and reports unresolved ownership. */
  const confirmDeleteSelected = () => {
    const selected = selectedCueUids();
    if (selected.length === 0) {
      setIsDeleteModalOpen(false);
      return;
    }
    const unresolved: string[] = [];
    let deletedCount = 0;

    for (const cueUid of selected) {
      const target = resolveCueDeleteTarget(cueUid);
      if (!target) {
        unresolved.push(cueUid);
        continue;
      }
      deleteCue(target.sequenceId, target.cueId);
      deletedCount += 1;
    }

    clearSelection();

    if (deletedCount > 0) {
      pushToast("success", `Deleted ${deletedCount} cue(s)`);
    }

    if (unresolved.length > 0) {
      pushToast(
        "warning",
        `Could not resolve ${unresolved.length} cue(s) to a sequence for deletion`,
      );
    }

    setIsDeleteModalOpen(false);
  };

  /** Checks a cue and its sequence context against the live toolbar search. */
  const cueMatchesSearch = (cue: Cue, sequence?: Sequence) =>
    search.matches([
      cue.identifiers.id,
      cue.identifiers.label,
      sequence?.identifiers.id,
      sequence?.identifiers.label,
      sequence ? `${sequence.identifiers.id}.${cue.identifiers.id}` : undefined,
    ]);

  /** Groups filtered cues by sequence through the pure projection model. */
  const groupedData = createMemo(() =>
    groupCueData($cues(), $sequences(), cueMatchesSearch),
  );

  /** Projects filtered sequence groups for list and grid presentation. */
  const cueGroups = createMemo(() => buildCueGroups(groupedData()));

  /** Indexes collapsed cue groups for row projection. */
  const collapsedGroupKeySet = createMemo(() => new Set(collapsedGroupKeys()));

  /** Toggles one group within the collapsed group set. */
  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return Array.from(next);
    });
  };

  /** Resolves the display group that owns a cue without applying toolbar filters. */
  /** Resolves a cue's unfiltered display group. */
  const resolveCueGroupKey = (cueUid: string): string | null =>
    cueGroupKeyForUid(cueUid, $cues(), $sequences());

  /** Flattens display groups into list rows using collapse state. */
  const cueListRows = createMemo(() =>
    buildCueListRows(cueGroups(), collapsedGroupKeySet()),
  );
  /** Returns cue selection order matching the grid presentation. */
  const cueGridOrder = createMemo(() => buildCueGridOrder(groupedData()));

  /** Selects and reveals a cue requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-CueList",
    (request) => {
      const cue = $cues()[request.uid];
      if (!cue) {
        return;
      }

      const selectCue = () => {
        setViewMode("list");
        const row = cueListRows().find(
          (candidate): candidate is CueListCueRow =>
            candidate.rowKind === "cue" && candidate.cueUid === request.uid,
        );
        if (!row) return;
        setSelectedCueUids([request.uid]);
        setListSelectionRequest({ row, requestId: request.requestId });
      };

      const row = cueListRows().find(
        (candidate) =>
          candidate.rowKind === "cue" && candidate.cueUid === request.uid,
      );
      if (!row) {
        const groupKey = resolveCueGroupKey(request.uid);
        if (groupKey) {
          setCollapsedGroupKeys((current) =>
            current.filter((key) => key !== groupKey),
          );
        }
        if (search.isFiltering()) {
          search.clear();
        }
        setTimeout(selectCue, 0);
      } else {
        selectCue();
      }
    },
    {
      accepts: (payload) => payload.type === "cue",
    },
  );

  useKeyboardShortcut({
    key: "v",
    handler: handleToggleSelectionMode,
    description: "Toggle selection mode",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Enter",
    handler: handleEnter,
    description: "Open selected item",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: handleDeleteSelected,
    description: "Delete selected cues",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected cues",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selection",
    componentId: panelId,
  });

  /** Captures the panel root used for list-mode keyboard handling. */
  const setPanelRootRef = (element: HTMLDivElement) => {
    panelRootRef = element;
  };

  /** Installs capture-phase Enter handling for the mounted list panel. */
  onMount(() => {
    if (!panelRootRef) return;
    panelRootRef.addEventListener("keydown", handlePanelKeyDownCapture, {
      capture: true,
    });
    onCleanup(() => {
      panelRootRef?.removeEventListener("keydown", handlePanelKeyDownCapture, {
        capture: true,
      });
    });
  });

  return {
    panelId,
    cues: $cues,
    search,
    selectionMode,
    viewMode,
    selectedCount,
    selectedCueUidSet,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    activeCueListRow,
    setActiveCueListRow,
    labelEditRequest,
    listSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    groupedData,
    cueGroups,
    cueListRows,
    gridDragSelection,
    gridClickSelection,
    setPanelRootRef,
    setViewMode,
    setSelectedCueUids,
    updateCueLabel,
    openCueEditor,
    handleCueItemClick,
    handleDragStart,
    handleEditSelected,
    handleDeleteSelected,
    openCueContextMenu,
    openCueGroupContextMenu,
    confirmDeleteSelected,
    handleToggleSelectionMode,
    toggleGroupCollapsed,
  };
}

export type CueListController = ReturnType<typeof createCueListController>;
