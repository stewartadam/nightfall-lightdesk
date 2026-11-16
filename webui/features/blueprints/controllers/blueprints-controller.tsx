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
import { v4 as uuidv4 } from "uuid";
import { openContextMenu } from "../../../components/providers/context-menu";
import {
  usePanelCapabilityRegistry,
  useRevealObjectCapability,
} from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import { commandClient } from "../../../lib/engine-commands";
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
  const crud = createCrudListState<types.Blueprint>({
    panelId,
    searchLabel: "Search blueprints",
    viewModeKey: "blueprints-list",
    orderedUids: (): readonly string[] => displayUids(),
    otherDialogOpen: () => isCreateModalOpen() || isEditModalOpen(),
    closeOtherDialogs: () => {
      setIsCreateModalOpen(false);
      setIsEditModalOpen(false);
    },
  });
  const { search } = crud;
  const [isCreateModalOpen, setIsCreateModalOpen] = createSignal(false);
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [createInitialId, setCreateInitialId] = createSignal(1);
  const [createInitialLabel, setCreateInitialLabel] = createSignal("");
  const [editInitialId, setEditInitialId] = createSignal(1);
  const [editInitialLabel, setEditInitialLabel] = createSignal("");
  const [editingBlueprintUid, setEditingBlueprintUid] = createSignal<
    string | null
  >(null);

  /** Returns the sole selected blueprint exposed to Properties, or null otherwise. */
  const propertiesBlueprint = createMemo(() => {
    const blueprintUid = crud.propertiesUid();
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

  /** UIDs of the blueprints currently shown, in display order, for range selection. */
  const displayUids = createMemo(() =>
    displayRows().map((blueprint) => blueprint.identifiers.uid),
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
      const selectBlueprint = () =>
        crud.revealRow(blueprint, request.uid, request.requestId);

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
  /** Sends a complete blueprint store command to the backend. */
  const sendStoreBlueprint = (blueprint: types.Blueprint) => {
    const command: types.BlueprintCommand = {
      type: "StoreBlueprint",
      data: blueprint,
    };
    commandClient.emit("BlueprintCommand", command);
  };

  /** Sends a numeric blueprint ID rename command to the backend. */
  const sendRenameBlueprint = (id: number, newId: number) => {
    const command: types.BlueprintCommand = {
      type: "RenameBlueprint",
      data: { id, new_id: newId },
    };
    commandClient.emit("BlueprintCommand", command);
  };

  /** Sends a blueprint deletion command to the backend. */
  const sendDeleteBlueprint = (id: number) => {
    const command: types.BlueprintCommand = {
      type: "DeleteBlueprint",
      data: id,
    };
    commandClient.emit("BlueprintCommand", command);
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
  const requestBlueprintLabelEdit = (blueprint: types.Blueprint) =>
    crud.requestLabelEdit(blueprint.identifiers.uid, () => blueprint);

  /** Recalls a blueprint through the shared command-line path. */
  const recallBlueprint = (blueprint: types.Blueprint, absolute = false) => {
    const command: types.EngineCommand = {
      type: "Eval",
      data: `recall blueprint ${blueprint.identifiers.id}${absolute ? " /absolute" : ""}`,
    };
    commandClient.emit("EngineCommand", command);
  };

  /** Captures current programmer values into an existing Blueprint definition. */
  const storeBlueprintFromProgrammer = (blueprint: types.Blueprint) => {
    const command: types.EngineCommand = {
      type: "Eval",
      data: `store blueprint ${blueprint.identifiers.id}`,
    };
    commandClient.emit("EngineCommand", command);
  };

  /** Duplicates a Blueprint definition under a fresh ID and stable identity. */
  const duplicateBlueprint = (blueprint: types.Blueprint) => {
    const id = nextBlueprintId(allDisplayRows());
    sendStoreBlueprint({
      ...blueprint,
      identifiers: {
        id,
        uid: uuidv4(),
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

    const cueId = dependent.match(/^objects:cue (\d+)(?: |$)/)?.[1];
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

    const sequenceId = dependent.match(/^objects:sequence (\d+)(?: |$)/)?.[1];
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

  /** Recalls a blueprint card once grid selection has declined the click. */
  const handleBlueprintClick = (blueprintUid: string) => {
    if (crud.dialogOpen()) return;
    const blueprint = $blueprints()[blueprintUid];
    if (!blueprint) return;
    recallBlueprint(blueprint);
  };

  /** Opens blueprint creation with the first available numeric ID. */
  const handleCreate = () => {
    if (crud.isDeleteModalOpen() || isEditModalOpen()) return;
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
        uid: uuidv4(),
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
    if (crud.isDeleteModalOpen() || isCreateModalOpen()) return;
    const [blueprintUid] = crud.selectedUids();
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
    crud.setSelectionModeEnabled(false);
  };

  /** Opens recall, create, edit, rename, and delete actions for a blueprint. */
  const openBlueprintContextMenu = (
    blueprint: types.Blueprint,
    x: number,
    y: number,
  ) => {
    crud.selectForContextMenu(blueprint.identifiers.uid);
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
          disabled: crud.selectedCount() !== 1,
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
            crud.selectedCount() > 1
              ? `Delete ${crud.selectedCount()} Blueprints`
              : "Delete Blueprint",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: crud.requestDelete,
        },
      ],
    });
  };

  /** Deletes all selected blueprints and resets interaction state. */
  const confirmDeleteSelected = () =>
    crud.confirmDelete((uid) => {
      const blueprint = $blueprints()[uid];
      if (blueprint) sendDeleteBlueprint(blueprint.identifiers.id);
    });

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create blueprint",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "v",
    handler: crud.handleToggleSelectionMode,
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
    handler: crud.requestDelete,
    description: "Delete selected blueprints",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: crud.requestDelete,
    description: "Delete selected blueprints",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: crud.handleEscape,
    description: "Cancel or clear selection",
    componentId: panelId,
  });

  return {
    panelId,
    crud,
    allDisplayRows,
    displayRows,
    isCreateModalOpen,
    setIsCreateModalOpen,
    isEditModalOpen,
    setIsEditModalOpen,
    createInitialId,
    createInitialLabel,
    editInitialId,
    editInitialLabel,
    updateBlueprintLabel,
    handleCreate,
    handleCreateSubmit,
    handleEditSelected,
    handleEditSubmit,
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
