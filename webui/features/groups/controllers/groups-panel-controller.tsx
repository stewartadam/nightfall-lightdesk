// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import { commandClient } from "../../../lib/engine-commands";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { useSharedStore } from "../../../lib/use-shared-store";
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
  const $groups = useSharedStore(groups);
  const panelId = props.initialPanelId ?? props.id;
  const crud = createCrudListState<types.Group>({
    panelId,
    searchLabel: "Search groups",
    viewModeKey: "groups-list",
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
  const [editingGroupUid, setEditingGroupUid] = createSignal<string | null>(
    null,
  );

  /** Resolves the group Properties edits: the sole selected one, if it still exists. */
  const propertiesGroup = createMemo(() => {
    const groupUid = crud.propertiesUid();
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

  /** UIDs of the groups currently shown, in display order, for range selection. */
  const displayUids = createMemo(() =>
    displayRows().map((group) => group.identifiers.uid),
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
      const selectGroup = () =>
        crud.revealRow(group, request.uid, request.requestId);

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
  /** Sends a complete group record to the backend store command. */
  const sendStoreGroup = (group: types.Group) => {
    const command: types.GroupCommand = {
      type: "StoreGroup",
      data: group,
    };
    commandClient.emit("GroupCommand", command);
  };

  /** Requests an identifier change for an existing group. */
  const sendRenameGroup = (id: number, newId: number) => {
    const command: types.GroupCommand = {
      type: "RenameGroup",
      data: { id, new_id: newId },
    };
    commandClient.emit("GroupCommand", command);
  };

  /** Deletes a group by its numeric showfile identifier. */
  const sendDeleteGroup = (id: number) => {
    const command: types.GroupCommand = {
      type: "DeleteGroup",
      data: id,
    };
    commandClient.emit("GroupCommand", command);
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
  const requestGroupLabelEdit = (group: types.Group) =>
    crud.requestLabelEdit(group.identifiers.uid, () => group);

  /** Applies programmer selection semantics derived from keyboard modifiers. */
  const applyGroupSelection = (
    group: types.Group,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    const command = buildGroupProgrammerCommand(
      group.identifiers.id,
      modifiers,
    );
    commandClient.emit("ProgrammerCommand", command);
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
    commandClient.emit("ProgrammerCommand", command);
  };

  /** Opens contextual programmer and CRUD actions for a group. */
  const openGroupContextMenu = (group: types.Group, x: number, y: number) => {
    crud.selectForContextMenu(group.identifiers.uid);
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
          disabled: crud.selectedCount() !== 1,
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
            crud.selectedCount() > 1
              ? `Delete ${crud.selectedCount()} Groups`
              : "Delete Group",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: crud.requestDelete,
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

  /** Applies a grid card to the programmer once grid selection has declined the click. */
  const handleGroupClick = (group: types.Group, event: MouseEvent) => {
    if (crud.dialogOpen()) return;
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
    if (crud.dialogOpen()) return;
    if (!modifiers.altKey) return;
    applyGroupSelection(group, modifiers);
  };

  /** Opens the create dialog with the first available group ID. */
  const handleCreate = () => {
    if (crud.isDeleteModalOpen() || isEditModalOpen()) return;
    const id = nextAvailableGroupId(allDisplayRows());
    setCreateInitialId(id);
    setCreateInitialLabel(`Group ${id}`);
    setIsCreateModalOpen(true);
  };

  /** Stores a newly submitted group and closes the create dialog. */
  const handleCreateSubmit = (payload: { id: number; label: string }) => {
    const group = createEmptyGroup(payload, uuidv4());
    sendStoreGroup(group);
    setIsCreateModalOpen(false);
  };

  /** Opens the entity editor for the sole selected group. */
  const handleEditSelected = () => {
    if (crud.isDeleteModalOpen() || isCreateModalOpen()) return;
    const [groupUid] = crud.selectedUids();
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
    crud.setSelectionModeEnabled(false);
  };

  /** Deletes every selected group and resets local selection state. */
  const confirmDeleteSelected = () =>
    crud.confirmDelete((uid) => {
      const group = $groups()[uid];
      if (group) sendDeleteGroup(group.identifiers.id);
    });

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create group",
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
    description: "Delete selected groups",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: crud.requestDelete,
    description: "Delete selected groups",
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
    updateGroupLabel,
    openGroupContextMenu,
    handleContextMenu,
    handleGroupClick,
    handleGroupListRowClick,
    handleCreate,
    handleCreateSubmit,
    handleEditSelected,
    handleEditSubmit,
    confirmDeleteSelected,
  };
}

export type GroupsPanelController = ReturnType<
  typeof createGroupsPanelController
>;
