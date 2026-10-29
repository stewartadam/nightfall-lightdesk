// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createEffect, createMemo, createSignal } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import type {
  CrudListDataGridEditRequest,
  CrudListDataGridSelectionRequest,
} from "../../../components/widgets/crud/crud-list-data-grid";
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
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { macroRuns, macros } from "../../../state/appStores";
import { pushToast } from "../../../state/notifications";
import type { Macro } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import MacroProperties from "../components/macro-properties";
import {
  buildDeleteMacroCommand,
  buildRenameMacroCommand,
  buildStartMacroCommand,
  buildStopMacroCommand,
  buildStoreMacroCommand,
  createEmptyMacro,
  macroRunStatus,
  nextAvailableMacroId,
  sortMacrosById,
} from "../model/macro-model";
import { sendMacroCommand } from "../services/macro-commands";

/** Storage key for the Macros list's grid or list presentation. */
const VIEW_MODE_KEY = "macro-list";

export interface MacroListControllerOptions {
  /** Dockview ID of the Macros panel. */
  panelId: string;
}

/**
 * Owns the Macros panel: search, grid and list selection, running and stopping macros, and the
 * commands that create, renumber, rename and delete them. Properties edits the selected macro.
 */
export function createMacroListController(options: MacroListControllerOptions) {
  const $macros = useShallowStore(macros);
  const $macroRuns = useShallowStore(macroRuns);
  const panelId = options.panelId;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search macros",
  });
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode(VIEW_MODE_KEY),
  );
  const [selectedMacroUids, setSelectedMacroUids] = createSignal<string[]>([]);
  const [inspectedMacroUid, setInspectedMacroUid] = createSignal<string | null>(
    null,
  );
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [editingMacroUid, setEditingMacroUid] = createSignal<string | null>(
    null,
  );
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<Macro>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<Macro>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Lists every macro in ID order before the search filter. */
  const allMacroList = createMemo(() => sortMacrosById($macros()));
  /** ID of the last macro this panel created, kept until the store holds it. */
  let lastCreatedId: number | undefined;
  /** Forgets the last created ID once the store echoes it, so a later delete frees it. */
  createEffect(() => {
    if (
      allMacroList().some((macro) => macro.identifiers.id === lastCreatedId)
    ) {
      lastCreatedId = undefined;
    }
  });

  /** Lists the macros matching the toolbar search by ID, label or command text. */
  const macroList = createMemo(() =>
    allMacroList().filter((macro) =>
      search.matches([
        macro.identifiers.id,
        macro.identifiers.label,
        macro.commands,
        macro.release_commands,
      ]),
    ),
  );

  /** UIDs of the macros currently shown, in display order, for range selection. */
  const macroUids = createMemo(() =>
    macroList().map((macro) => macro.identifiers.uid),
  );
  /** Number of selected macros. */
  const selectedCount = createMemo(() => selectedMacroUids().length);
  /** Selected macro UIDs indexed for constant-time checks while rendering. */
  const selectedMacroUidSet = createMemo(() => new Set(selectedMacroUids()));

  /** Resolves the first selected macro, which toolbar actions act on. */
  const selectedMacro = createMemo(() => {
    const [uid] = selectedMacroUids();
    return uid ? $macros()[uid] : undefined;
  });

  /**
   * UID of the macro Properties edits: the one selected macro, nothing for several, or the
   * macro last inspected from a card's settings button when nothing is selected.
   */
  const propertiesMacroUid = createMemo(() => {
    if (selectedCount() === 1) return selectedMacroUids()[0] ?? null;
    if (selectedCount() > 1) return null;
    return inspectedMacroUid();
  });

  const propertiesInspector = usePropertiesInspector(
    panelId,
    "Macro",
    () => <MacroProperties macroUid={propertiesMacroUid()} />,
    { priority: 10, autoActivate: true },
  );

  /** Replaces the selection with `uids`. */
  const selectMacros = (uids: string[]) => setSelectedMacroUids(uids);

  /** Clears the selection. */
  const clearSelection = () => selectMacros([]);
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Turns grid selection mode on or off, dropping the selection when it ends. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) clearSelection();
  };

  /** Persists and applies the grid or list presentation. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode(
      VIEW_MODE_KEY,
      viewMode(),
      mode,
      setViewModeSignal,
      {
        onEnterListMode: () => setSelectionModeEnabled(false),
      },
    );
  };

  /** Whether a dialog owns the keyboard, so list shortcuts and clicks step aside. */
  const dialogOpen = () => isEditModalOpen() || isDeleteModalOpen();

  /** Returns whether any body of `macro` is running now. */
  const isRunning = (macro: Macro) =>
    macroRunStatus($macroRuns(), macro) !== undefined;

  /** Stops `macro` when it runs, otherwise starts its press body. */
  const toggleRun = (macro: Macro) => {
    sendMacroCommand(
      isRunning(macro)
        ? buildStopMacroCommand(macro.identifiers.id)
        : buildStartMacroCommand(macro.identifiers.id),
    );
  };

  /** Renames a macro, ignoring unchanged labels. */
  const updateMacroLabel = (macro: Macro, label: string) => {
    if (label === macro.identifiers.label) return;
    sendMacroCommand(
      buildStoreMacroCommand({
        ...macro,
        identifiers: { ...macro.identifiers, label },
      }),
    );
  };

  /** Shows `macro` in Properties without changing the selection. */
  const inspectMacro = (macro: Macro) => {
    setInspectedMacroUid(macro.identifiers.uid);
    propertiesInspector.activate();
  };

  /** Selects a macro requested by the object palette, clearing a search that hides it. */
  useRevealObjectCapability(
    panelId,
    (request) => {
      const macro = $macros()[request.uid];
      if (!macro) return;
      /** Selects the requested macro once any search reset has settled. */
      const reveal = () => {
        setViewMode("list");
        setSelectionModeEnabled(false);
        selectMacros([macro.identifiers.uid]);
        setListSelectionRequest({ row: macro, requestId: request.requestId });
        propertiesInspector.activate();
      };
      if (!macroList().includes(macro) && search.isFiltering()) {
        search.clear();
        setTimeout(reveal, 0);
      } else {
        reveal();
      }
    },
    { accepts: (payload) => payload.type === "macro" },
  );

  /** Starts inline label editing for `macro` in the current presentation. */
  const requestMacroLabelEdit = (macro: Macro) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(macro.identifiers.uid);
      return;
    }
    setLabelEditRequest({
      row: macro,
      columnId: "label",
      requestId: Date.now(),
    });
  };

  /** Opens the row actions for `macro`, selecting it first unless it is already selected. */
  const openMacroContextMenu = (macro: Macro, x: number, y: number) => {
    if (!selectedMacroUidSet().has(macro.identifiers.uid))
      selectMacros([macro.identifiers.uid]);
    const running = isRunning(macro);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "toggle-macro-run",
          label: running ? "Stop Macro" : "Run Macro",
          icon: running ? StopIcon : PlayIcon,
          shortcut: "Enter",
          onSelect: () => toggleRun(macro),
        },
        {
          id: "inspect-macro",
          label: "Show Properties",
          icon: GearSixIcon,
          onSelect: () => inspectMacro(macro),
        },
        {
          id: "rename-macro",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestMacroLabelEdit(macro),
        },
        { id: "macro-menu-separator", type: "separator" },
        {
          id: "delete-macro",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Macros`
              : "Delete Macro",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Selects a card in selection mode, otherwise runs or stops its macro. */
  const handleMacroClick = (macro: Macro, event: MouseEvent) => {
    if (dialogOpen()) return;
    if (gridClickSelection.handleCardClick(macro.identifiers.uid, event))
      return;
    toggleRun(macro);
  };

  /** Runs or stops the one selected macro. */
  const handleRunSelected = () => {
    const macro = selectedMacro();
    if (selectedCount() !== 1 || dialogOpen() || !macro) return;
    toggleRun(macro);
  };

  /** Creates an empty macro under the next free ID and selects it, ready to type into. */
  const handleCreate = () => {
    if (dialogOpen()) return;
    const pending = lastCreatedId === undefined ? [] : [lastCreatedId];
    const macro = createEmptyMacro(
      nextAvailableMacroId(allMacroList(), pending),
    );
    lastCreatedId = macro.identifiers.id;
    sendMacroCommand(buildStoreMacroCommand(macro));
    setSelectionModeEnabled(false);
    search.clear();
    selectMacros([macro.identifiers.uid]);
    propertiesInspector.activate();
  };

  /** Opens the ID and label editor for the one selected macro. */
  const handleEditSelected = () => {
    const macro = selectedMacro();
    if (selectedCount() !== 1 || dialogOpen() || !macro) return;
    setEditingMacroUid(macro.identifiers.uid);
    setIsEditModalOpen(true);
    setSelectionModeEnabled(false);
  };

  /** Macro being edited in the ID and label dialog, if it still exists. */
  const editingMacro = createMemo(() => {
    const uid = editingMacroUid();
    return uid ? $macros()[uid] : undefined;
  });

  /** Closes the editor dialog and forgets which macro it was editing. */
  const closeEditor = () => {
    setIsEditModalOpen(false);
    setEditingMacroUid(null);
  };

  /**
   * Applies a new ID and label from the editor dialog. A taken ID is refused up front, and the
   * label is stored under the macro's current ID before renumbering, so a refused renumber can
   * never relabel another macro.
   */
  const handleEditSubmit = (payload: { id: number; label: string }) => {
    const macro = editingMacro();
    if (!macro) {
      closeEditor();
      return;
    }
    const idTaken = allMacroList().some(
      (other) =>
        other.identifiers.id === payload.id &&
        other.identifiers.uid !== macro.identifiers.uid,
    );
    if (idTaken) {
      pushToast("warning", `Macro ${payload.id} already exists.`);
      return;
    }
    updateMacroLabel(macro, payload.label);
    if (payload.id !== macro.identifiers.id)
      sendMacroCommand(
        buildRenameMacroCommand(macro.identifiers.id, payload.id),
      );
    closeEditor();
  };

  /** Asks to confirm deleting the selected macros. */
  const handleDeleteSelected = () => {
    if (dialogOpen() || selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Deletes every selected macro after confirmation, stopping the ones that run. */
  const confirmDeleteSelected = () => {
    for (const uid of selectedMacroUids()) {
      const macro = $macros()[uid];
      if (macro)
        sendMacroCommand(buildDeleteMacroCommand(macro.identifiers.id));
    }
    setSelectionModeEnabled(false);
    setIsDeleteModalOpen(false);
  };

  /** Toggles grid selection mode; list mode always selects rows directly. */
  const handleToggleSelectionMode = () => {
    if (dialogOpen() || viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Clears the search, then the selection, then selection mode, one per Escape press. */
  const handleEscape = () => {
    if (dialogOpen()) return true;
    if (search.clear()) return true;
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

  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: macroUids,
    selectedIds: selectedMacroUids,
    onSelectionChange: selectMacros,
  });
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: macroUids,
    selectedIds: selectedMacroUids,
    onSelectionChange: selectMacros,
    multiSelectOnPlainClick: true,
  });

  for (const [key, handler, description] of [
    ["n", handleCreate, "Create macro"],
    ["v", handleToggleSelectionMode, "Toggle selection mode"],
    ["Enter", handleRunSelected, "Run or stop selected macro"],
    ["e", handleEditSelected, "Edit selected macro"],
    ["Delete", handleDeleteSelected, "Delete selected macros"],
    ["Backspace", handleDeleteSelected, "Delete selected macros"],
  ] as const) {
    useKeyboardShortcut({ key, handler, description, componentId: panelId });
  }
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selected macros",
    componentId: panelId,
  });

  return {
    panelId,
    search,
    selectionMode,
    viewMode,
    setViewMode,
    isEditModalOpen,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    dialogOpen,
    editingMacro,
    closeEditor,
    labelEditRequest,
    listSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    allMacroList,
    macroList,
    macroRuns: $macroRuns,
    selectedCount,
    selectedMacro,
    selectedMacroUidSet,
    selectMacros,
    isRunning,
    toggleRun,
    inspectMacro,
    updateMacroLabel,
    openMacroContextMenu,
    handleMacroClick,
    handleRunSelected,
    handleCreate,
    handleEditSelected,
    handleEditSubmit,
    handleDeleteSelected,
    confirmDeleteSelected,
    handleToggleSelectionMode,
    gridDragSelection,
    gridClickSelection,
  };
}

export type MacroListController = ReturnType<typeof createMacroListController>;
