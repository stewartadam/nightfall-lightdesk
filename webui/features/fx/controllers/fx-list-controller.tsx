// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
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
import {
  createDefaultFx,
  createDefaultStepFx,
  deleteFx,
  deleteFxModule,
  deleteStepFx,
  refreshAvailableFxModules,
  storeFx,
  storeFxModule,
  storeStepFx,
} from "../../../lib/fx-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import {
  availableFxModules,
  dockApi,
  fx,
  fxModules,
  pushToast,
  stepFx,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { FxPropertiesPanel } from "../components/fx-list-dialogs";
import {
  createModuleFxListEntry,
  createRegularFxListEntry,
  createStepFxListEntry,
  type FxListEntry,
  nextFxId,
} from "../model/fx-list-model";

export interface FxListControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns mixed FX CRUD, selection, navigation, creation, and shortcuts. */
export function createFxListController(props: FxListControllerProps) {
  const $fx = useStore(fx);
  const $stepFx = useStore(stepFx);
  const $fxModules = useStore(fxModules);
  const $availableFxModules = useStore(availableFxModules);
  const $dockApi = useStore(dockApi);
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search FX",
  });
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("fx-list"),
  );
  const [selectedFxUids, setSelectedFxUids] = createSignal<string[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [isModuleDialogOpen, setIsModuleDialogOpen] = createSignal(false);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<FxListEntry>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<FxListEntry>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Projects every stored FX family into one stably ordered list. */
  const fxList = createMemo<FxListEntry[]>(() => {
    const regularFxEntries = Object.values($fx()).map(createRegularFxListEntry);
    const stepFxEntries = Object.values($stepFx()).map(createStepFxListEntry);
    const moduleFxEntries = Object.values($fxModules()).map(
      createModuleFxListEntry,
    );

    return [...regularFxEntries, ...stepFxEntries, ...moduleFxEntries].sort(
      (a, b) =>
        a.identifiers.id - b.identifiers.id ||
        a.typeLabel.localeCompare(b.typeLabel) ||
        a.identifiers.label.localeCompare(b.identifiers.label),
    );
  });

  /** Returns FX entries matching the live toolbar search query. */
  const visibleFxList = createMemo(() =>
    fxList().filter((fxEntry) =>
      search.matches([
        fxEntry.identifiers.id,
        fxEntry.identifiers.label,
        fxEntry.typeLabel,
        fxEntry.detail,
      ]),
    ),
  );

  /** Indexes projected FX entries by UID for selection and reveal requests. */
  const fxListByUid = createMemo(() => {
    const byUid = new Map<string, FxListEntry>();
    for (const fxEntry of fxList()) {
      byUid.set(fxEntry.identifiers.uid, fxEntry);
    }
    return byUid;
  });

  /** Selects and reveals an FX entry requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-FxList",
    (request) => {
      const fxEntry = fxListByUid().get(request.uid);
      if (!fxEntry) {
        return;
      }

      /** Switches to list mode and selects the requested projected entry. */
      const selectEntry = () => {
        setViewMode("list");
        setSelectedFxUids([request.uid]);
        setListSelectionRequest({
          row: fxEntry,
          requestId: request.requestId,
        });
      };

      if (!visibleFxList().includes(fxEntry) && search.isFiltering()) {
        search.clear();
        setTimeout(selectEntry, 0);
      } else {
        selectEntry();
      }
    },
    {
      accepts: (payload) =>
        payload.type === "fx" ||
        payload.type === "stepfx" ||
        payload.type === "fxModule",
    },
  );

  /** Resolves current selection UIDs to projected FX entries. */
  const selectedEntries = createMemo(() =>
    selectedFxUids()
      .map((fxUid) => fxListByUid().get(fxUid))
      .filter((fxEntry): fxEntry is FxListEntry => fxEntry !== undefined),
  );
  /** Returns the number of valid entries in the current selection. */
  const selectedCount = createMemo(() => selectedEntries().length);
  /** Indexes selected FX UIDs for constant-time presentation checks. */
  const selectedFxUidSet = createMemo(() => new Set(selectedFxUids()));
  /** Reports whether the sole selected entry supports the FX editor. */
  const canEditSelected = createMemo(() => {
    const selected = selectedEntries();
    return selected.length === 1 && selected[0].canEdit;
  });
  /** Reports whether every selected entry supports deletion. */
  const canDeleteSelected = createMemo(() => {
    const selected = selectedEntries();
    return (
      selected.length > 0 && selected.every((fxEntry) => fxEntry.canDelete)
    );
  });
  /** Tracks the single selected entry whose details should appear in Properties. */
  const propertiesFxEntry = createMemo(() => {
    const selected = selectedEntries();
    return selected.length === 1 ? selected[0] : null;
  });
  /** Resolves the selected module FX definition for config editing in Properties. */
  const propertiesModuleFx = createMemo(() => {
    const entry = propertiesFxEntry();
    if (entry?.type !== "module") return null;
    return $fxModules()[entry.identifiers.uid] ?? null;
  });
  /** Computes the next available id used when opening the module FX dialog. */
  const nextAvailableFxId = createMemo(() => nextFxId(fxList()));

  usePropertiesInspector(
    panelId,
    "Effect",
    () => (
      <FxPropertiesPanel
        entry={propertiesFxEntry()}
        moduleFx={propertiesModuleFx()}
        onLabelCommit={(fxEntry, label) => updateFxEntryLabel(fxEntry, label)}
        onModuleConfigCommit={(moduleFx, config) =>
          updateModuleFxConfig(moduleFx, config)
        }
        onModuleSelectionCommit={(moduleFx, selection) =>
          updateModuleFxSelection(moduleFx, selection)
        }
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Stores an FX label change while preserving the entry-specific payload. */
  const updateFxEntryLabel = (fxEntry: FxListEntry, label: string) => {
    if (label === fxEntry.identifiers.label) return;
    if (fxEntry.type === "regular") {
      const currentFx = $fx()[fxEntry.identifiers.uid];
      if (!currentFx) return;
      storeFx({
        ...currentFx,
        identifiers: {
          ...currentFx.identifiers,
          label,
        },
      });
      return;
    }
    if (fxEntry.type === "module") {
      const currentModuleFx = $fxModules()[fxEntry.identifiers.uid];
      if (!currentModuleFx) return;
      storeFxModule({
        identifiers: {
          ...currentModuleFx.identifiers,
          label,
        },
        module_name: currentModuleFx.module_name,
        selection: currentModuleFx.selection,
        config: currentModuleFx.config,
        merge: false,
      });
      return;
    }
    const currentStepFx = $stepFx()[fxEntry.identifiers.uid];
    if (!currentStepFx) return;
    storeStepFx({
      ...currentStepFx,
      identifiers: { ...currentStepFx.identifiers, label },
    });
  };

  /** Stores a module FX config replacement while preserving its module and selection. */
  const updateModuleFxConfig = (
    moduleFx: types.StoredFxModule,
    config: Record<string, string>,
  ) => {
    storeFxModule({
      identifiers: moduleFx.identifiers,
      module_name: moduleFx.module_name,
      selection: moduleFx.selection,
      config,
      merge: false,
    });
  };

  /** Stores a module FX selection replacement while preserving its module and config. */
  const updateModuleFxSelection = (
    moduleFx: types.StoredFxModule,
    selection: types.SpatialSelection,
  ) => {
    storeFxModule({
      identifiers: moduleFx.identifiers,
      module_name: moduleFx.module_name,
      selection,
      config: moduleFx.config,
      merge: false,
    });
  };

  /** Requests inline editing for a regular FX label cell. */
  const requestFxLabelEdit = (fxEntry: FxListEntry) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(fxEntry.identifiers.uid);
      return;
    }
    /** Publishes a fresh list-cell editing request. */
    const startEdit = () =>
      setLabelEditRequest({
        row: fxEntry,
        columnId: "label",
        requestId: Date.now(),
      });
    startEdit();
  };

  /** Clears all selected FX UIDs. */
  const clearSelection = () => {
    setSelectedFxUids([]);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Toggles card selection mode and clears selection when leaving it. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  /** Persists and applies the FX-list presentation mode. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode("fx-list", viewMode(), mode, setViewModeSignal, {
      onEnterListMode: () => setSelectionModeEnabled(false),
    });
  };

  /** Toggles one FX UID within the current selection. */
  const toggleSelection = (fxUid: string) => {
    setSelectedFxUids((current) => {
      const next = new Set(current);
      if (next.has(fxUid)) {
        next.delete(fxUid);
      } else {
        next.add(fxUid);
      }
      return Array.from(next);
    });
  };

  /** Focuses or opens the editor for one regular FX definition. */
  const openFxEditor = (fxUid: string) => {
    const api = $dockApi();
    if (!api) return;

    const fxMap = $fx();
    const fxEntry = fxMap[fxUid];
    if (!fxEntry) return;

    const panelId = `fx-editor-${fxUid}`;

    // Focus existing panel or open new one
    const panel = api.getPanel(panelId);
    if (panel) {
      return panel.focus();
    }
    api.addPanel({
      id: panelId,
      component: "FxEditor",
      title: `FX ${fxEntry.identifiers.id}: ${fxEntry.identifiers.label}`,
      params: { initialFxUid: fxUid },
    });
  };

  /** Focuses or opens the dedicated sheet editor for one stored or new Step FX draft. */
  const openStepFxEditor = (
    step: types.StepFx,
    initialDraft?: types.StepFx,
  ) => {
    const api = $dockApi();
    if (!api) return;
    const panelId = `step-fx-editor-${step.identifiers.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) return panel.focus();
    api.addPanel({
      id: panelId,
      component: "StepFxEditor",
      title: `Step FX ${step.identifiers.id}: ${step.identifiers.label}`,
      params: {
        initialStepFxUid: step.identifiers.uid,
        ...(initialDraft ? { initialDraft } : {}),
      },
    });
  };

  /** Opens an editable FX entry or explains why its type is read-only. */
  const openFxEntry = (fxEntry: FxListEntry) => {
    if (fxEntry.type === "step") {
      const stored = $stepFx()[fxEntry.identifiers.uid];
      if (stored) openStepFxEditor(stored);
      return;
    }
    if (fxEntry.type !== "regular") {
      pushToast(
        "info",
        `${fxEntry.typeLabel} FX entries are listed here, but editing is not available from this panel yet.`,
      );
      return;
    }

    openFxEditor(fxEntry.identifiers.uid);
  };

  /** Opens or selects an FX card according to the interaction mode. */
  const handleFxItemClick = (fxUid: string) => {
    if (isDeleteModalOpen()) return;
    if (selectionMode()) {
      toggleSelection(fxUid);
      return;
    }

    const fxEntry = fxListByUid().get(fxUid);
    if (!fxEntry) return;
    openFxEntry(fxEntry);
  };

  /** Opens the sole selected editable FX entry. */
  const handleEditSelected = () => {
    if (isDeleteModalOpen()) return;
    const [selectedFxEntry] = selectedEntries();
    if (!selectedFxEntry) return;
    openFxEntry(selectedFxEntry);
    setSelectionModeEnabled(false);
  };

  /** Opens deletion confirmation for a fully deletable selection. */
  const handleDeleteSelected = () => {
    const selected = selectedEntries();
    if (selected.length === 0) return;
    if (!selected.every((fxEntry) => fxEntry.canDelete)) {
      pushToast("info", "Step FX cannot be deleted from this panel right now.");
      return;
    }
    setIsDeleteModalOpen(true);
  };

  /** Selects a context-clicked FX entry unless it is already selected. */
  const selectForContextMenu = (fxUid: string) => {
    if (selectedFxUidSet().has(fxUid)) return;
    setSelectedFxUids([fxUid]);
  };

  /** Opens create, edit, rename, and deletion actions for an FX entry. */
  const openFxContextMenu = (fxEntry: FxListEntry, x: number, y: number) => {
    selectForContextMenu(fxEntry.identifiers.uid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-fx",
          label: fxEntry.canEdit ? "Open Effect" : "Open Effect",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          disabled: !fxEntry.canEdit,
          onSelect: () => openFxEntry(fxEntry),
        },
        {
          id: "rename-fx",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          disabled: false,
          onSelect: () => requestFxLabelEdit(fxEntry),
        },
        {
          id: "new-fx",
          label: "New Effect",
          icon: PlusIcon,
          shortcut: "N",
          onSelect: handleCreate,
        },
        { id: "fx-menu-separator", type: "separator" },
        {
          id: "delete-fx",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Effects`
              : "Delete Effect",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          disabled: !canDeleteSelected(),
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Deletes supported selected FX entries and resets selection state. */
  const confirmDeleteSelected = () => {
    const selected = selectedEntries();
    if (selected.length === 0) {
      setIsDeleteModalOpen(false);
      return;
    }
    for (const fxEntry of selected) {
      if (!fxEntry.canDelete) continue;
      if (fxEntry.type === "module") {
        deleteFxModule(fxEntry.identifiers.id);
      } else if (fxEntry.type === "step") {
        deleteStepFx(fxEntry.identifiers.id);
      } else {
        deleteFx(fxEntry.identifiers.id);
      }
    }

    clearSelection();
    setIsDeleteModalOpen(false);
  };

  /** Toggles grid selection mode when no modal blocks interaction. */
  const handleToggleSelectionMode = () => {
    if (isDeleteModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Clears the highest-priority transient FX-list state. */
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

  /** Creates a regular waveform FX and opens its editor. */
  const handleCreateRegular = () => {
    const newFx = createDefaultFx(nextAvailableFxId());
    storeFx(newFx);
    setTimeout(() => openFxEditor(newFx.identifiers.uid), 100);
  };

  /** Opens a valid unsaved Step FX chase draft in its dedicated editor. */
  const handleCreateStep = () => {
    const draft = createDefaultStepFx(nextAvailableFxId());
    openStepFxEditor(draft, draft);
  };

  /** Opens the module FX dialog after requesting a fresh module catalog. */
  const handleCreateModule = () => {
    refreshAvailableFxModules()
      .then(() => {
        setIsModuleDialogOpen(true);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        pushToast("warning", `Could not refresh module list: ${message}`);
      });
  };

  /** Stores the module FX created by the dialog. */
  const handleModuleDialogCreate = (request: types.StoredFxModuleRequest) => {
    storeFxModule(request);
    setIsModuleDialogOpen(false);
    setSelectedFxUids([]);
  };

  /** Preserves the existing create shortcut as regular FX creation. */
  const handleCreate = handleCreateRegular;
  /** Owns rectangular drag selection for FX cards. */
  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => visibleFxList().map((fxEntry) => fxEntry.identifiers.uid),
    selectedIds: selectedFxUids,
    onSelectionChange: setSelectedFxUids,
  });
  /** Owns click and modifier selection semantics for FX cards. */
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => visibleFxList().map((fxEntry) => fxEntry.identifiers.uid),
    selectedIds: selectedFxUids,
    onSelectionChange: setSelectedFxUids,
    multiSelectOnPlainClick: true,
  });

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create FX",
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
    key: "Delete",
    handler: handleDeleteSelected,
    description: "Delete selected FX",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected FX",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selection",
    componentId: panelId,
  });

  return {
    panelId,
    search,
    availableFxModules: $availableFxModules,
    fxList,
    visibleFxList,
    selectedCount,
    selectedFxUidSet,
    canEditSelected,
    canDeleteSelected,
    nextAvailableFxId,
    selectionMode,
    viewMode,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    isModuleDialogOpen,
    setIsModuleDialogOpen,
    labelEditRequest,
    listSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    gridDragSelection,
    gridClickSelection,
    setViewMode,
    setSelectedFxUids,
    updateFxEntryLabel,
    handleCreateRegular,
    handleCreateStep,
    handleCreateModule,
    handleModuleDialogCreate,
    handleEditSelected,
    handleDeleteSelected,
    handleToggleSelectionMode,
    handleFxItemClick,
    openFxEntry,
    openFxContextMenu,
    confirmDeleteSelected,
  };
}

export type FxListController = ReturnType<typeof createFxListController>;
