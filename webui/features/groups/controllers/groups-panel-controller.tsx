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
import { groups } from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  buildGroupProgrammerCommand,
  createEmptyGroup,
  groupSearchValues,
  nextAvailableGroupId,
  sortGroupsById,
} from "../model/groups-panel-model";

export interface GroupsPanelControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns group CRUD, selection, filtering, reveal, and keyboard behavior. */
export function createGroupsPanelController(props: GroupsPanelControllerProps) {
  const $groups = useStore(groups);
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search groups",
  });

  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("groups-list"),
  );
  const [selectedGroupUids, setSelectedGroupUids] = createSignal<string[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = createSignal(false);
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [createInitialId, setCreateInitialId] = createSignal(1);
  const [createInitialLabel, setCreateInitialLabel] = createSignal("");
  const [editInitialId, setEditInitialId] = createSignal(1);
  const [editInitialLabel, setEditInitialLabel] = createSignal("");
  const [editingGroupUid, setEditingGroupUid] = createSignal<string | null>(
    null,
  );
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<types.Group>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<types.Group>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Counts selected groups for toolbar and dialog state. */
  const selectedCount = createMemo(() => selectedGroupUids().length);
  /** Indexes selected group UIDs for constant-time presentation checks. */
  const selectedUidSet = createMemo(() => new Set(selectedGroupUids()));
  /** Resolves the sole selected group for the properties inspector. */
  const propertiesGroup = createMemo(() => {
    if (selectedCount() !== 1) return null;
    const [groupUid] = selectedGroupUids();
    return groupUid ? ($groups()[groupUid] ?? null) : null;
  });

  usePropertiesInspector(
    panelId,
    "Group",
    () => (
      <CrudLabelProperties
        entry={propertiesGroup()}
        entityName="Group"
        getId={(group) => group.identifiers.id}
        getLabel={(group) => group.identifiers.label}
        onLabelCommit={(group, label) => updateGroupLabel(group, label)}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Returns all groups in stable display order before toolbar filtering. */
  const allDisplayRows = createMemo(() => sortGroupsById($groups()));

  /** Returns groups matching the live toolbar search query. */
  const displayRows = createMemo(() =>
    allDisplayRows().filter((group) =>
      search.matches(groupSearchValues(group)),
    ),
  );

  /** Selects and reveals a group requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-Groups",
    (request) => {
      const group = $groups()[request.uid];
      if (!group) {
        return;
      }

      /** Switches to list mode and reveals the requested group row. */
      const selectGroup = () => {
        setViewMode("list");
        setSelectedGroupUids([request.uid]);
        setListSelectionRequest({ row: group, requestId: request.requestId });
      };

      if (!displayRows().includes(group) && search.isFiltering()) {
        search.clear();
        setTimeout(selectGroup, 0);
      } else {
        selectGroup();
      }
    },
    {
      accepts: (payload) => payload.type === "group",
    },
  );
  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => displayRows().map((group) => group.identifiers.uid),
    selectedIds: selectedGroupUids,
    onSelectionChange: setSelectedGroupUids,
  });
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => displayRows().map((group) => group.identifiers.uid),
    selectedIds: selectedGroupUids,
    onSelectionChange: setSelectedGroupUids,
    multiSelectOnPlainClick: true,
  });

  /** Clears the current group selection across list and grid modes. */
  const clearSelection = () => {
    setSelectedGroupUids([]);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Updates grid selection mode and clears stale selections on exit. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  /** Persists a new list/grid view mode and resets grid-only selection state. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode(
      "groups-list",
      viewMode(),
      mode,
      setViewModeSignal,
      {
        onEnterListMode: () => setSelectionModeEnabled(false),
      },
    );
  };

  /** Toggles one group within the local CRUD selection. */
  const toggleSelection = (groupUid: string) => {
    setSelectedGroupUids((current) => {
      const next = new Set(current);
      if (next.has(groupUid)) {
        next.delete(groupUid);
      } else {
        next.add(groupUid);
      }
      return Array.from(next);
    });
  };

  /** Sends a complete group record to the backend store command. */
  const sendStoreGroup = (group: types.Group) => {
    const command: types.GroupCommand = {
      type: "StoreGroup",
      data: group,
    };
    engineRuntime.sendCommand({ module: "GroupCommand", command });
  };

  /** Requests an identifier change for an existing group. */
  const sendRenameGroup = (id: number, newId: number) => {
    const command: types.GroupCommand = {
      type: "RenameGroup",
      data: { id, new_id: newId },
    };
    engineRuntime.sendCommand({ module: "GroupCommand", command });
  };

  /** Deletes a group by its numeric showfile identifier. */
  const sendDeleteGroup = (id: number) => {
    const command: types.GroupCommand = {
      type: "DeleteGroup",
      data: id,
    };
    engineRuntime.sendCommand({ module: "GroupCommand", command });
  };

  /** Stores a group label change without changing the group selection. */
  const updateGroupLabel = (group: types.Group, label: string) => {
    if (label === group.identifiers.label) return;
    sendStoreGroup({
      ...group,
      identifiers: {
        ...group.identifiers,
        label,
      },
    });
  };

  /** Requests inline editing for the selected group label cell. */
  const requestGroupLabelEdit = (group: types.Group) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(group.identifiers.uid);
      return;
    }
    setLabelEditRequest({
      row: group,
      columnId: "label",
      requestId: Date.now(),
    });
  };

  /** Applies programmer selection semantics derived from keyboard modifiers. */
  const applyGroupSelection = (
    group: types.Group,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    const command = buildGroupProgrammerCommand(
      group.identifiers.id,
      modifiers,
    );
    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  /** Applies programmer selection from a grid-card pointer event. */
  const selectGroup = (group: types.Group, event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
    }
    applyGroupSelection(group, {
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
  };

  /** Removes one group from the current programmer selection. */
  const removeGroupSelection = (group: types.Group) => {
    const command = buildGroupProgrammerCommand(group.identifiers.id, {
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
    });
    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  /** Ensures a context-menu target is represented in local CRUD selection. */
  const selectForContextMenu = (groupUid: string) => {
    if (selectedUidSet().has(groupUid)) return;
    setSelectedGroupUids([groupUid]);
  };

  /** Opens contextual programmer and CRUD actions for a group. */
  const openGroupContextMenu = (group: types.Group, x: number, y: number) => {
    const groupUid = group.identifiers.uid;
    selectForContextMenu(groupUid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "select-group",
          label: "Select Group",
          onSelect: () =>
            applyGroupSelection(group, {
              shiftKey: false,
              ctrlKey: false,
              metaKey: false,
            }),
        },
        {
          id: "remove-group-selection",
          label: "Remove from Programmer Selection",
          onSelect: () => removeGroupSelection(group),
        },
        { id: "group-selection-separator", type: "separator" },
        {
          id: "new-group",
          label: "New Group",
          icon: PlusIcon,
          shortcut: "N",
          onSelect: handleCreate,
        },
        {
          id: "edit-group",
          label: "Edit Group",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          disabled: selectedCount() !== 1,
          onSelect: handleEditSelected,
        },
        {
          id: "rename-group",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestGroupLabelEdit(group),
        },
        { id: "group-delete-separator", type: "separator" },
        {
          id: "delete-group",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Groups`
              : "Delete Group",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  /** Converts a card context-menu event into the shared menu coordinates. */
  const handleContextMenu = (group: types.Group, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openGroupContextMenu(group, event.clientX, event.clientY);
  };

  /** Selects a grid card locally or applies it to the programmer. */
  const handleGroupClick = (group: types.Group, event: MouseEvent) => {
    if (isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen()) return;
    if (selectionMode()) {
      toggleSelection(group.identifiers.uid);
      return;
    }
    selectGroup(group, event);
  };

  /** Applies an Alt-clicked list row to the programmer. */
  const handleGroupListRowClick = (
    group: types.Group,
    modifiers: {
      altKey: boolean;
      shiftKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
    },
  ) => {
    if (isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen()) return;
    if (!modifiers.altKey) return;
    applyGroupSelection(group, modifiers);
  };

  /** Opens the create dialog with the first available group ID. */
  const handleCreate = () => {
    if (isDeleteModalOpen() || isEditModalOpen()) return;
    const id = nextAvailableGroupId(allDisplayRows());
    setCreateInitialId(id);
    setCreateInitialLabel(`Group ${id}`);
    setIsCreateModalOpen(true);
  };

  /** Stores a newly submitted group and closes the create dialog. */
  const handleCreateSubmit = (payload: { id: number; label: string }) => {
    const group = createEmptyGroup(payload, crypto.randomUUID());
    sendStoreGroup(group);
    setIsCreateModalOpen(false);
  };

  /** Opens the entity editor for the sole selected group. */
  const handleEditSelected = () => {
    if (isDeleteModalOpen() || isCreateModalOpen()) return;
    const [groupUid] = selectedGroupUids();
    if (!groupUid) return;
    const group = $groups()[groupUid];
    if (!group) return;
    setEditingGroupUid(groupUid);
    setEditInitialId(group.identifiers.id);
    setEditInitialLabel(group.identifiers.label);
    setIsEditModalOpen(true);
  };

  /** Persists identifier or label changes from the group editor. */
  const handleEditSubmit = (payload: { id: number; label: string }) => {
    const groupUid = editingGroupUid();
    if (!groupUid) {
      setIsEditModalOpen(false);
      return;
    }
    const group = $groups()[groupUid];
    if (!group) {
      setIsEditModalOpen(false);
      return;
    }

    if (payload.id !== group.identifiers.id) {
      sendRenameGroup(group.identifiers.id, payload.id);
    }

    if (
      payload.id !== group.identifiers.id ||
      payload.label !== group.identifiers.label
    ) {
      sendStoreGroup({
        ...group,
        identifiers: {
          ...group.identifiers,
          id: payload.id,
          label: payload.label,
        },
      });
    }

    setIsEditModalOpen(false);
    setEditingGroupUid(null);
    setSelectionModeEnabled(false);
  };

  /** Opens deletion confirmation when at least one group is selected. */
  const handleDeleteSelected = () => {
    if (isCreateModalOpen() || isEditModalOpen()) return;
    if (selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Deletes every selected group and resets local selection state. */
  const confirmDeleteSelected = () => {
    const groupMap = $groups();
    for (const uid of selectedGroupUids()) {
      const group = groupMap[uid];
      if (!group) continue;
      sendDeleteGroup(group.identifiers.id);
    }
    setSelectedGroupUids([]);
    setIsDeleteModalOpen(false);
    setSelectionModeEnabled(false);
  };

  /** Toggles multi-selection mode when the grid view can support it. */
  const handleToggleSelectionMode = () => {
    if (isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Cancels the highest-priority modal, filter, or selection state. */
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
    description: "Create group",
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
    description: "Delete selected groups",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected groups",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Cancel or clear selection",
    componentId: panelId,
  });

  /** Reports whether modal state should suppress panel interactions. */
  const isInteractionBlocked = () =>
    isDeleteModalOpen() || isCreateModalOpen() || isEditModalOpen();

  return {
    panelId,
    search,
    selectionMode,
    viewMode,
    selectedGroupUids,
    setSelectedGroupUids,
    selectedCount,
    selectedUidSet,
    allDisplayRows,
    displayRows,
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
    updateGroupLabel,
    openGroupContextMenu,
    handleContextMenu,
    handleGroupClick,
    handleGroupListRowClick,
    handleCreate,
    handleCreateSubmit,
    handleEditSelected,
    handleEditSubmit,
    handleDeleteSelected,
    confirmDeleteSelected,
    handleToggleSelectionMode,
    isInteractionBlocked,
  };
}

export type GroupsPanelController = ReturnType<
  typeof createGroupsPanelController
>;
