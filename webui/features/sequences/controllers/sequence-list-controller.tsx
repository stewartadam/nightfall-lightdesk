// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createEffect, createMemo, createSignal } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import type { CrudListDataGridEditRequest } from "../../../components/widgets/crud/crud-list-data-grid";
import {
  createCrudPanelSearch,
  createCrudPanelSearchQueryChangeEffect,
} from "../../../components/widgets/crud/crud-panel-search";
import type { CrudViewMode } from "../../../components/widgets/crud/crud-view-mode-toggle";
import { createCrudGridClickSelection } from "../../../components/widgets/crud/model/crud-grid-click-selection";
import { createCrudGridDragSelection } from "../../../components/widgets/crud/model/crud-grid-drag-selection";
import {
  changeCrudPanelViewMode,
  loadCrudPanelViewMode,
} from "../../../lib/crud-panel-view-mode";
import {
  deleteSequence,
  sendCueUpdate,
  sendSequenceUpdate,
} from "../../../lib/cue-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { duplicateSequencePayload } from "../../../lib/sequence-duplication";
import {
  createDefaultSequence,
  nextAvailableIdentifierId,
} from "../../../lib/sequence-factory";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  clearSequenceNavigationRequest,
  cues,
  dockApi,
  sequenceNavigationRequest,
  sequences,
} from "../../../state/appStores";
import type { Sequence } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  normalizeSequenceUid,
  sortSequencesForDisplay,
} from "../model/sequence-list-model";

export interface SequenceListControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns sequence-list CRUD, selection, duplication, navigation, and shortcuts. */
export function createSequenceListController(
  props: SequenceListControllerProps,
) {
  const $sequences = useShallowStore(sequences);
  const $cues = useShallowStore(cues);
  const $dockApi = useStore(dockApi);
  const $sequenceNavigationRequest = useStore(sequenceNavigationRequest);
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search sequences",
  });
  const [selectedSequenceUid, setSelectedSequenceUid] = createSignal<
    string | null
  >(null);
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("sequence-list"),
  );
  const [selectedSequenceUids, setSelectedSequenceUids] = createSignal<
    string[]
  >([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<Sequence>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);
  const sequenceButtonRefs = new Map<string, HTMLButtonElement>();
  /** Returns the number of sequences in the current multi-selection. */
  const selectedCount = createMemo(() => selectedSequenceUids().length);
  /** Indexes selected sequence UIDs for constant-time presentation checks. */
  const selectedSequenceUidSet = createMemo(
    () => new Set(selectedSequenceUids()),
  );

  /** Clears active and multi-selected sequence state across list and grid modes. */
  const clearSelection = () => {
    setSelectedSequenceUids([]);
    setSelectedSequenceUid(null);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Toggles card selection mode and clears selection when leaving it. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  /** Persists and applies the sequence-list presentation mode. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode(
      "sequence-list",
      viewMode(),
      mode,
      setViewModeSignal,
      {
        onEnterListMode: () => setSelectionModeEnabled(false),
      },
    );
  };

  /** Resolves a normalized sequence UID against the current store. */
  const findSequenceByUid = (sequenceUid: string): Sequence | undefined =>
    Object.values($sequences()).find(
      (sequence) =>
        normalizeSequenceUid(sequence.identifiers.uid) === sequenceUid,
    );

  /** Returns the sole selected sequence, or null for other selections. */
  const selectedSequence = createMemo(() => {
    if (selectedCount() !== 1) return null;
    const [sequenceUid] = selectedSequenceUids();
    return sequenceUid ? (findSequenceByUid(sequenceUid) ?? null) : null;
  });

  /** Exposes the current sequence to the Properties inspector. */
  const propertiesSequence = createMemo(() => {
    return selectedSequence();
  });

  usePropertiesInspector(
    panelId,
    "Sequence",
    () => (
      <CrudLabelProperties
        entry={propertiesSequence()}
        entityName="Sequence"
        getId={(sequence) => sequence.identifiers.id}
        getLabel={(sequence) => sequence.identifiers.label}
        onLabelCommit={(sequence, label) =>
          updateSequenceLabel(sequence, label)
        }
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Stores a sequence label change without changing the sequence ID or UID. */
  const updateSequenceLabel = (sequence: Sequence, label: string) => {
    if (label === sequence.identifiers.label) return;
    sendSequenceUpdate({
      ...sequence,
      identifiers: {
        ...sequence.identifiers,
        label,
      },
    });
  };

  /** Requests inline editing for the selected sequence label cell. */
  const requestSequenceLabelEdit = (sequence: Sequence) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(normalizeSequenceUid(sequence.identifiers.uid));
      return;
    }
    /** Publishes a fresh list-cell editing request. */
    const startEdit = () =>
      setLabelEditRequest({
        row: sequence,
        columnId: "label",
        requestId: Date.now(),
      });
    startEdit();
  };

  /** Toggles one normalized sequence UID within the multi-selection. */
  const toggleSelection = (sequenceUid: string) => {
    setSelectedSequenceUids((current) => {
      const next = new Set(current);
      if (next.has(sequenceUid)) {
        next.delete(sequenceUid);
      } else {
        next.add(sequenceUid);
      }
      return Array.from(next);
    });
  };

  /** Focuses or opens an editor for one sequence. */
  const openSequenceEditor = (sequence: Sequence) => {
    const sequenceUid = normalizeSequenceUid(sequence.identifiers.uid);
    setSelectedSequenceUid(sequenceUid);

    const api = $dockApi();
    if (!api) return;

    const panelId = `sequence-editor-panel-${sequence.identifiers.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      return panel.focus();
    }

    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: sequence.identifiers.label.trim()
        ? `Sequence ${sequence.identifiers.id}: ${sequence.identifiers.label}`
        : `Sequence ${sequence.identifiers.id}`,
      params: { initialSequenceUid: sequence.identifiers.uid },
    });
  };

  /** Opens or selects a sequence card according to the interaction mode. */
  const handleSequenceItemClick = (sequence: Sequence) => {
    if (isDeleteModalOpen()) return;
    const sequenceUid = normalizeSequenceUid(sequence.identifiers.uid);
    if (selectionMode()) {
      toggleSelection(sequenceUid);
      return;
    }
    openSequenceEditor(sequence);
  };

  /** Opens the sole selected sequence for editing. */
  const handleEditSelected = () => {
    if (isDeleteModalOpen()) return;
    const [selectedUid] = selectedSequenceUids();
    if (!selectedUid) return;
    const sequence = findSequenceByUid(selectedUid);
    if (!sequence) return;
    openSequenceEditor(sequence);
    setSelectionModeEnabled(false);
  };

  /** Opens deletion confirmation when at least one sequence is selected. */
  const handleDeleteSelected = () => {
    if (selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Duplicates a sequence and opens the copy for editing. */
  const duplicateSequence = (sourceSequence: Sequence) => {
    if (isDeleteModalOpen()) return;

    const duplicated = duplicateSequencePayload({
      sourceSequence,
      existingSequences: Object.values($sequences()),
      cuesByUid: $cues(),
      createUid: () => crypto.randomUUID().replace(/-/g, ""),
    });
    const batchId = crypto.randomUUID().replace(/-/g, "");

    sendSequenceUpdate(duplicated.sequence, batchId);
    for (const cue of duplicated.cues) {
      sendCueUpdate(cue, batchId);
    }
    setSelectionModeEnabled(false);
    setSelectedSequenceUids([
      normalizeSequenceUid(duplicated.sequence.identifiers.uid),
    ]);
    setSelectedSequenceUid(
      normalizeSequenceUid(duplicated.sequence.identifiers.uid),
    );
    setTimeout(() => openSequenceEditor(duplicated.sequence), 100);
  };

  /** Duplicates the selected sequence when exactly one sequence is selected. */
  const handleDuplicateSelected = () => {
    const sourceSequence = selectedSequence();
    if (!sourceSequence) return;
    duplicateSequence(sourceSequence);
  };

  /** Selects a context-clicked sequence unless it is already selected. */
  const selectForContextMenu = (sequenceUid: string) => {
    if (selectedSequenceUidSet().has(sequenceUid)) return;
    setSelectedSequenceUids([sequenceUid]);
    setSelectedSequenceUid(sequenceUid);
  };

  /** Opens create, edit, duplicate, and deletion actions for a sequence. */
  const openSequenceContextMenu = (
    sequence: Sequence,
    x: number,
    y: number,
  ) => {
    const sequenceUid = normalizeSequenceUid(sequence.identifiers.uid);
    selectForContextMenu(sequenceUid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-sequence",
          label: "Open Sequence",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          onSelect: () => openSequenceEditor(sequence),
        },
        {
          id: "rename-sequence",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestSequenceLabelEdit(sequence),
        },
        {
          id: "new-sequence",
          label: "New Sequence",
          icon: PlusIcon,
          shortcut: "N",
          onSelect: handleCreate,
        },
        {
          id: "duplicate-sequence",
          label: "Duplicate Sequence",
          icon: CopySimpleIcon,
          shortcut: "Cmd/Ctrl+D",
          onSelect: () => duplicateSequence(sequence),
        },
        { id: "sequence-menu-separator", type: "separator" },
        {
          id: "delete-sequence",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Sequences`
              : "Delete Sequence",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Deletes every selected sequence and resets interaction state. */
  const confirmDeleteSelected = () => {
    const selected = selectedSequenceUids();
    if (selected.length === 0) {
      setIsDeleteModalOpen(false);
      return;
    }

    for (const sequenceUid of selected) {
      const sequence = findSequenceByUid(sequenceUid);
      if (!sequence) continue;
      deleteSequence(sequence.identifiers.id);
    }

    clearSelection();
    setSelectionModeEnabled(false);
    setIsDeleteModalOpen(false);
  };

  /** Toggles grid selection mode when no modal blocks interaction. */
  const handleToggleSelectionMode = () => {
    if (isDeleteModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Clears the highest-priority transient sequence-list state. */
  const handleEscape = () => {
    if (isDeleteModalOpen()) return true;
    if (search.clear()) {
      return true;
    }
    if (selectedCount() > 0) {
      clearSelection();
      return true;
    }
    if (selectionMode()) {
      setSelectionModeEnabled(false);
      return true;
    }
    return false;
  };

  /** Creates a new sequence from shared defaults and opens it for editing. */
  const handleCreate = () => {
    const newId = nextAvailableIdentifierId(Object.values($sequences()));
    const newSequence: Sequence = createDefaultSequence({ id: newId });

    sendSequenceUpdate(newSequence);
    setTimeout(() => openSequenceEditor(newSequence), 100);
  };

  /** Returns all sequences in stable display order before toolbar filtering. */
  const allDisplayRows = createMemo(() => {
    return sortSequencesForDisplay(Object.values($sequences()));
  });

  /** Returns sequences matching the live toolbar search query. */
  const displayRows = createMemo(() =>
    allDisplayRows().filter((sequence) =>
      search.matches([
        sequence.identifiers.id,
        sequence.identifiers.label,
        sequence.steps.length,
      ]),
    ),
  );
  /** Owns rectangular drag selection for sequence cards. */
  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () =>
      displayRows().map((sequence) =>
        normalizeSequenceUid(sequence.identifiers.uid),
      ),
    selectedIds: selectedSequenceUids,
    onSelectionChange: (ids) => {
      setSelectedSequenceUids(ids);
      setSelectedSequenceUid(ids[0] ?? null);
    },
  });
  /** Owns click and modifier selection semantics for sequence cards. */
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () =>
      displayRows().map((sequence) =>
        normalizeSequenceUid(sequence.identifiers.uid),
      ),
    selectedIds: selectedSequenceUids,
    onSelectionChange: (ids) => {
      setSelectedSequenceUids(ids);
      setSelectedSequenceUid(ids[0] ?? null);
    },
    multiSelectOnPlainClick: true,
  });

  /** Selects and focuses a sequence after toolbar filters allow its card to render. */
  const selectAndFocusSequence = (sequenceUid: string) => {
    setSelectedSequenceUids([]);
    setSelectedSequenceUid(sequenceUid);
    queueMicrotask(() => {
      const button = sequenceButtonRefs.get(sequenceUid);
      button?.focus();
      button?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  /** Handles pending sequence navigation requests after row data changes. */
  createEffect(() => {
    const request = $sequenceNavigationRequest();
    if (!request) {
      return;
    }

    const targetUid = normalizeSequenceUid(request.sequenceUid);
    const targetSequence = allDisplayRows().find(
      (sequence) =>
        normalizeSequenceUid(sequence.identifiers.uid) === targetUid,
    );
    if (!targetSequence) {
      clearSequenceNavigationRequest(request.requestId);
      return;
    }

    const targetIsVisible = displayRows().some(
      (sequence) =>
        normalizeSequenceUid(sequence.identifiers.uid) === targetUid,
    );
    if (!targetIsVisible && search.isFiltering()) {
      clearSequenceNavigationRequest(request.requestId);
      search.clear();
      setTimeout(() => selectAndFocusSequence(targetUid), 0);
      return;
    }

    selectAndFocusSequence(targetUid);
    clearSequenceNavigationRequest(request.requestId);
  });

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create sequence",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "v",
    handler: handleToggleSelectionMode,
    description: "Toggle selection mode",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Enter",
    handler: handleEditSelected,
    description: "Open selected item",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "$mod+d",
    handler: handleDuplicateSelected,
    description: "Duplicate selected sequence",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: handleDeleteSelected,
    description: "Delete selected sequences",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected sequences",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selection",
    componentId: panelId,
  });

  /** Registers a sequence card for navigation focus requests. */
  const registerSequenceButton = (
    sequenceUid: string,
    element: HTMLButtonElement,
  ) => {
    sequenceButtonRefs.set(sequenceUid, element);
  };

  return {
    panelId,
    search,
    allDisplayRows,
    displayRows,
    selectedSequenceUid,
    selectedSequenceUidSet,
    selectedCount,
    selectionMode,
    viewMode,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    labelEditRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    gridDragSelection,
    gridClickSelection,
    setViewMode,
    setSelectedSequenceUids,
    setSelectedSequenceUid,
    updateSequenceLabel,
    handleCreate,
    handleEditSelected,
    handleDuplicateSelected,
    handleDeleteSelected,
    handleToggleSelectionMode,
    handleSequenceItemClick,
    openSequenceEditor,
    openSequenceContextMenu,
    confirmDeleteSelected,
    registerSequenceButton,
  };
}

export type SequenceListController = ReturnType<
  typeof createSequenceListController
>;
