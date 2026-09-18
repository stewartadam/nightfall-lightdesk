// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { FloppyDiskIcon } from "@squidlab/phosphor-solid/floppy-disk";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import {
  usePanelCapabilityRegistry,
  useRevealObjectCapability,
} from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
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
import { engineRuntime } from "../../../lib/engine-runtime";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { REVEAL_OBJECT_CAPABILITY } from "../../../lib/panel-capabilities";
import { openOrFocusPanel } from "../../../lib/panel-open-command";
import {
  blueprintDependencies,
  blueprints,
  cues as cueStore,
  dockApi,
  sequences as sequenceStore,
} from "../../../state/appStores";
import * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  blueprintAttributeGroups,
  blueprintAttributeNames,
} from "../model/blueprint-values";
import {
  nextBlueprintId,
  sortBlueprintsForDisplay,
} from "../model/blueprints-model";

export interface BlueprintsControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns blueprint CRUD, recall, selection, modal state, and shortcuts. */
export function createBlueprintsController(props: BlueprintsControllerProps) {
  const $blueprints = useStore(blueprints);
  const $blueprintDependencies = useStore(blueprintDependencies);
  const $cues = useStore(cueStore);
  const $sequences = useStore(sequenceStore);
  const $dockApi = useStore(dockApi);
  const { invokePanelCapability } = usePanelCapabilityRegistry();
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search blueprints",
  });

  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("blueprints-list"),
  );
  const [selectedBlueprintUids, setSelectedBlueprintUids] = createSignal<
    string[]
  >([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = createSignal(false);
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [createInitialId, setCreateInitialId] = createSignal(1);
  const [createInitialLabel, setCreateInitialLabel] = createSignal("");
  const [editInitialId, setEditInitialId] = createSignal(1);
  const [editInitialLabel, setEditInitialLabel] = createSignal("");
  const [editingBlueprintUid, setEditingBlueprintUid] = createSignal<
    string | null
  >(null);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<types.Blueprint>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<types.Blueprint>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Returns the number of blueprints in the current selection. */
  const selectedCount = createMemo(() => selectedBlueprintUids().length);
  /** Indexes selected blueprint UIDs for constant-time presentation checks. */
  const selectedUidSet = createMemo(() => new Set(selectedBlueprintUids()));
  /** Returns the sole blueprint exposed to Properties, or null otherwise. */
  const propertiesBlueprint = createMemo(() => {
    if (selectedCount() !== 1) return null;
    const [blueprintUid] = selectedBlueprintUids();
    return blueprintUid ? ($blueprints()[blueprintUid] ?? null) : null;
  });

  usePropertiesInspector(
    panelId,
    "Blueprint",
    () => (
      <CrudLabelProperties
        entry={propertiesBlueprint()}
        entityName="Blueprint"
        getId={(blueprint) => blueprint.identifiers.id}
        getLabel={(blueprint) => blueprint.identifiers.label}
        onLabelCommit={(blueprint, label) =>
          updateBlueprintLabel(blueprint, label)
        }
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Returns all blueprints in stable display order before toolbar filtering. */
  const allDisplayRows = createMemo(() =>
    sortBlueprintsForDisplay(Object.values($blueprints())),
  );

  /** Returns blueprints matching the live toolbar search query. */
  const displayRows = createMemo(() =>
    allDisplayRows().filter((blueprint) =>
      search.matches([
        blueprint.identifiers.id,
        blueprint.identifiers.label,
        ...blueprintAttributeNames(blueprint),
      ]),
    ),
  );

  /** Selects and reveals a blueprint requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-BlueprintsPanel",
    (request) => {
      const blueprint = $blueprints()[request.uid];
      if (!blueprint) {
        return;
      }

      /** Switches to list mode and selects the requested blueprint row. */
      const selectBlueprint = () => {
        setViewMode("list");
        setSelectedBlueprintUids([request.uid]);
        setListSelectionRequest({
          row: blueprint,
          requestId: request.requestId,
        });
      };

      if (!displayRows().includes(blueprint) && search.isFiltering()) {
        search.clear();
        setTimeout(selectBlueprint, 0);
      } else {
        selectBlueprint();
      }
    },
    {
      accepts: (payload) => payload.type === "blueprint",
    },
  );
  /** Owns rectangular drag selection for blueprint cards. */
  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () =>
      displayRows().map((blueprint) => blueprint.identifiers.uid),
    selectedIds: selectedBlueprintUids,
    onSelectionChange: setSelectedBlueprintUids,
  });
  /** Owns click and modifier selection semantics for blueprint cards. */
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () =>
      displayRows().map((blueprint) => blueprint.identifiers.uid),
    selectedIds: selectedBlueprintUids,
    onSelectionChange: setSelectedBlueprintUids,
    multiSelectOnPlainClick: true,
  });

  /** Clears the current blueprint selection across list and grid modes. */
  const clearSelection = () => {
    setSelectedBlueprintUids([]);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Toggles card selection mode and clears selection when leaving it. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  /** Persists and applies the blueprint presentation mode. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode(
      "blueprints-list",
      viewMode(),
      mode,
      setViewModeSignal,
      {
        onEnterListMode: () => setSelectionModeEnabled(false),
      },
    );
  };

  /** Toggles one blueprint UID within the current selection. */
  const toggleSelection = (blueprintUid: string) => {
    setSelectedBlueprintUids((current) => {
      const next = new Set(current);
      if (next.has(blueprintUid)) {
        next.delete(blueprintUid);
      } else {
        next.add(blueprintUid);
      }
      return Array.from(next);
    });
  };

  /** Sends a complete blueprint store command to the backend. */
  const sendStoreBlueprint = (blueprint: types.Blueprint) => {
    const command: types.BlueprintCommand = {
      type: "StoreBlueprint",
      data: blueprint,
    };
    engineRuntime.sendCommand({ module: "BlueprintCommand", command });
  };

  /** Sends a numeric blueprint ID rename command to the backend. */
  const sendRenameBlueprint = (id: number, newId: number) => {
    const command: types.BlueprintCommand = {
      type: "RenameBlueprint",
      data: { id, new_id: newId },
    };
    engineRuntime.sendCommand({ module: "BlueprintCommand", command });
  };

  /** Sends a blueprint deletion command to the backend. */
  const sendDeleteBlueprint = (id: number) => {
    const command: types.BlueprintCommand = {
      type: "DeleteBlueprint",
      data: id,
    };
    engineRuntime.sendCommand({ module: "BlueprintCommand", command });
  };

  /** Stores a blueprint label change without changing fixture contents. */
  const updateBlueprintLabel = (blueprint: types.Blueprint, label: string) => {
    if (label === blueprint.identifiers.label) return;
    sendStoreBlueprint({
      ...blueprint,
      identifiers: {
        ...blueprint.identifiers,
        label,
      },
    });
  };

  /** Requests inline editing for the selected blueprint label cell. */
  const requestBlueprintLabelEdit = (blueprint: types.Blueprint) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(blueprint.identifiers.uid);
      return;
    }
    /** Publishes a fresh list-cell editing request. */
    const startEdit = () =>
      setLabelEditRequest({
        row: blueprint,
        columnId: "label",
        requestId: Date.now(),
      });
    startEdit();
  };

  /** Recalls a blueprint through the shared desk command path. */
  const recallBlueprint = (blueprint: types.Blueprint, absolute = false) => {
    const command: types.DeskCommand = {
      type: "Eval",
      data: `recall blueprint ${blueprint.identifiers.id}${absolute ? " /absolute" : ""}`,
    };
    engineRuntime.sendCommand({ module: "DeskCommand", command });
  };

  /** Captures current programmer values into an existing Blueprint definition. */
  const storeBlueprintFromProgrammer = (blueprint: types.Blueprint) => {
    const command: types.DeskCommand = {
      type: "Eval",
      data: `store blueprint ${blueprint.identifiers.id}`,
    };
    engineRuntime.sendCommand({ module: "DeskCommand", command });
  };

  /** Duplicates a Blueprint definition under a fresh ID and stable identity. */
  const duplicateBlueprint = (blueprint: types.Blueprint) => {
    const id = nextBlueprintId(allDisplayRows());
    sendStoreBlueprint({
      ...blueprint,
      identifiers: {
        id,
        uid: crypto.randomUUID(),
        label: `${blueprint.identifiers.label} Copy`,
      },
    });
  };

  /** Captures the programmer into the sole selected Blueprint. */
  const handleStoreSelected = () => {
    const blueprint = propertiesBlueprint();
    if (blueprint) storeBlueprintFromProgrammer(blueprint);
  };

  /** Duplicates the sole selected Blueprint into the first free numeric ID. */
  const handleDuplicateSelected = () => {
    const blueprint = propertiesBlueprint();
    if (blueprint) duplicateBlueprint(blueprint);
  };

  /** Opens the programmer, cue, or sequence represented by an indexed dependent label. */
  const navigateToBlueprintDependent = (dependent: string) => {
    if (dependent.startsWith("programmer:")) {
      openOrFocusPanel(
        $dockApi(),
        "panel-ProgrammerGrid",
        "ProgrammerGrid",
        "Programmer",
      );
      return;
    }

    const cueId = dependent.match(/^cues:cue (\d+) /)?.[1];
    if (cueId) {
      const cue = Object.values($cues()).find(
        (candidate) => candidate.identifiers.id === Number(cueId),
      );
      if (!cue) return;
      openOrFocusPanel($dockApi(), "panel-CueList", "CueList", "Cues");
      invokePanelCapability("panel-CueList", REVEAL_OBJECT_CAPABILITY, {
        type: "cue",
        uid: cue.identifiers.uid,
      });
      return;
    }

    const sequenceId = dependent.match(/^cues:sequence (\d+) /)?.[1];
    if (!sequenceId) return;
    const sequence = Object.values($sequences()).find(
      (candidate) => candidate.identifiers.id === Number(sequenceId),
    );
    if (!sequence) return;
    openOrFocusPanel(
      $dockApi(),
      "panel-SequenceList",
      "SequenceList",
      "Sequences",
    );
    invokePanelCapability("panel-SequenceList", REVEAL_OBJECT_CAPABILITY, {
      type: "sequence",
      uid: sequence.identifiers.uid,
    });
  };

  /** Recalls or selects a blueprint card according to interaction mode. */
  const handleBlueprintClick = (blueprintUid: string) => {
    if (isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen()) return;
    const blueprint = $blueprints()[blueprintUid];
    if (!blueprint) return;

    if (selectionMode()) {
      toggleSelection(blueprintUid);
      return;
    }

    recallBlueprint(blueprint);
  };

  /** Opens blueprint creation with the first available numeric ID. */
  const handleCreate = () => {
    if (isDeleteModalOpen() || isEditModalOpen()) return;
    const id = nextBlueprintId(allDisplayRows());
    setCreateInitialId(id);
    setCreateInitialLabel(`Blueprint ${id}`);
    setIsCreateModalOpen(true);
  };

  /** Builds and stores a new attribute blueprint from modal input. */
  const handleCreateSubmit = (payload: { id: number; label: string }) => {
    const blueprint: types.Blueprint = {
      identifiers: {
        id: payload.id,
        uid: crypto.randomUUID(),
        label: payload.label,
      },
      values: {},
      inclusion_settings: {
        inclusion_mode: types.InclusionMode.COPY,
        inclusion_filters: [],
        exclusion_filters: [],
      },
      references: {
        palettes: [],
        fx: [],
      },
    };

    sendStoreBlueprint(blueprint);
    setIsCreateModalOpen(false);
  };

  /** Opens editing for the sole selected blueprint. */
  const handleEditSelected = () => {
    if (isDeleteModalOpen() || isCreateModalOpen()) return;
    const [blueprintUid] = selectedBlueprintUids();
    if (!blueprintUid) return;
    const blueprint = $blueprints()[blueprintUid];
    if (!blueprint) return;

    setEditingBlueprintUid(blueprintUid);
    setEditInitialId(blueprint.identifiers.id);
    setEditInitialLabel(blueprint.identifiers.label);
    setIsEditModalOpen(true);
  };

  /** Applies blueprint ID and label changes from the edit modal. */
  const handleEditSubmit = (payload: { id: number; label: string }) => {
    const blueprintUid = editingBlueprintUid();
    if (!blueprintUid) {
      setIsEditModalOpen(false);
      return;
    }

    const blueprint = $blueprints()[blueprintUid];
    if (!blueprint) {
      setIsEditModalOpen(false);
      return;
    }

    if (payload.id !== blueprint.identifiers.id) {
      sendRenameBlueprint(blueprint.identifiers.id, payload.id);
    }

    if (
      payload.id !== blueprint.identifiers.id ||
      payload.label !== blueprint.identifiers.label
    ) {
      sendStoreBlueprint({
        ...blueprint,
        identifiers: {
          ...blueprint.identifiers,
          id: payload.id,
          label: payload.label,
        },
      });
    }

    setIsEditModalOpen(false);
    setEditingBlueprintUid(null);
    setSelectionModeEnabled(false);
  };

  /** Opens deletion confirmation when blueprints are selected. */
  const handleDeleteSelected = () => {
    if (isCreateModalOpen() || isEditModalOpen()) return;
    if (selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Selects a context-clicked blueprint unless it is already selected. */
  const selectForContextMenu = (blueprintUid: string) => {
    if (selectedUidSet().has(blueprintUid)) return;
    setSelectedBlueprintUids([blueprintUid]);
  };

  /** Opens recall, create, edit, rename, and delete actions for a blueprint. */
  const openBlueprintContextMenu = (
    blueprint: types.Blueprint,
    x: number,
    y: number,
  ) => {
    selectForContextMenu(blueprint.identifiers.uid);
    const dependents =
      $blueprintDependencies()[blueprint.identifiers.uid] ?? [];
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "recall-blueprint",
          label: "Recall Blueprint",
          onSelect: () => recallBlueprint(blueprint),
        },
        {
          id: "recall-blueprint-absolute",
          label: "Recall Blueprint Absolute",
          onSelect: () => recallBlueprint(blueprint, true),
        },
        {
          id: "store-blueprint-from-programmer",
          label: "Store/Update from Programmer",
          icon: FloppyDiskIcon,
          onSelect: () => storeBlueprintFromProgrammer(blueprint),
        },
        {
          id: "duplicate-blueprint",
          label: "Duplicate Blueprint",
          icon: CopySimpleIcon,
          onSelect: () => duplicateBlueprint(blueprint),
        },
        ...(dependents.length > 0
          ? [
              {
                type: "submenu" as const,
                id: "blueprint-dependents",
                label: `Dependents (${dependents.length})`,
                items: dependents.map((dependent, index) => ({
                  id: `blueprint-dependent-${index}`,
                  label: dependent.replace(/^[^:]+:/, ""),
                  onSelect: () => navigateToBlueprintDependent(dependent),
                })),
              },
            ]
          : []),
        {
          id: "new-blueprint",
          label: "New Blueprint",
          icon: PlusIcon,
          shortcut: "N",
          onSelect: handleCreate,
        },
        {
          id: "edit-blueprint",
          label: "Edit Blueprint",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          disabled: selectedCount() !== 1,
          onSelect: handleEditSelected,
        },
        {
          id: "rename-blueprint",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestBlueprintLabelEdit(blueprint),
        },
        { id: "blueprint-menu-separator", type: "separator" },
        {
          id: "delete-blueprint",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Blueprints`
              : "Delete Blueprint",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Deletes all selected blueprints and resets interaction state. */
  const confirmDeleteSelected = () => {
    const blueprintMap = $blueprints();
    for (const uid of selectedBlueprintUids()) {
      const blueprint = blueprintMap[uid];
      if (!blueprint) continue;
      sendDeleteBlueprint(blueprint.identifiers.id);
    }
    setSelectedBlueprintUids([]);
    setIsDeleteModalOpen(false);
    setSelectionModeEnabled(false);
  };

  /** Toggles grid selection mode when no modal blocks interaction. */
  const handleToggleSelectionMode = () => {
    if (isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Closes or clears the highest-priority transient blueprint state. */
  const handleEscape = () => {
    if (isDeleteModalOpen()) {
      setIsDeleteModalOpen(false);
      return true;
    }
    if (isEditModalOpen()) {
      setIsEditModalOpen(false);
      return true;
    }
    if (isCreateModalOpen()) {
      setIsCreateModalOpen(false);
      return true;
    }
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

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create blueprint",
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
    description: "Delete selected blueprints",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected blueprints",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Cancel or clear selection",
    componentId: panelId,
  });

  return {
    panelId,
    search,
    allDisplayRows,
    displayRows,
    selectedCount,
    selectedUidSet,
    selectionMode,
    viewMode,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    isCreateModalOpen,
    setIsCreateModalOpen,
    isEditModalOpen,
    setIsEditModalOpen,
    createInitialId,
    createInitialLabel,
    editInitialId,
    editInitialLabel,
    labelEditRequest,
    listSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    gridDragSelection,
    gridClickSelection,
    setViewMode,
    setSelectedBlueprintUids,
    updateBlueprintLabel,
    handleCreate,
    handleCreateSubmit,
    handleEditSelected,
    handleEditSubmit,
    handleDeleteSelected,
    handleToggleSelectionMode,
    handleBlueprintClick,
    recallBlueprint,
    storeBlueprintFromProgrammer,
    duplicateBlueprint,
    handleStoreSelected,
    handleDuplicateSelected,
    blueprintAttributeGroups,
    blueprintAttributeNames,
    blueprintDependents: (blueprintUid: string) =>
      $blueprintDependencies()[blueprintUid] ?? [],
    openBlueprintContextMenu,
    confirmDeleteSelected,
  };
}

export type BlueprintsController = ReturnType<
  typeof createBlueprintsController
>;
