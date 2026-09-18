// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Show } from "solid-js";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import CrudInlineLabelEditor from "../../../components/widgets/crud/crud-inline-label-editor";
import CrudListDataGrid from "../../../components/widgets/crud/crud-list-data-grid";
import CrudPanelSearch from "../../../components/widgets/crud/crud-panel-search";
import {
  CRUD_CARD_CLASS,
  CRUD_CARD_SELECTED_CLASS,
  CRUD_CARD_UNSELECTED_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudScrollArea from "../../../components/widgets/crud/crud-scroll-area";
import CrudViewModeToggle from "../../../components/widgets/crud/crud-view-mode-toggle";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../../../components/widgets/entity-editor-dialog";
import type * as types from "../../../types";
import type { GroupsPanelController } from "../controllers/groups-panel-controller";

interface GroupsPanelViewProps {
  controller: GroupsPanelController;
}

interface GroupCardProps extends GroupsPanelViewProps {
  group: types.Group;
}

/** Renders one props-driven group card with inline label editing. */
function GroupCard(props: GroupCardProps) {
  const controller = props.controller;
  const uid = props.group.identifiers.uid;
  /** Reports whether this group belongs to the local CRUD selection. */
  const isSelected = () => controller.selectedUidSet().has(uid);

  return (
    <button
      type="button"
      data-crud-select-id={uid}
      class={CRUD_CARD_CLASS}
      classList={{
        [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
        [CRUD_CARD_SELECTED_CLASS]: isSelected(),
      }}
      onClick={(event) => {
        if (controller.gridDragSelection.consumeSuppressedClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (controller.gridClickSelection.handleCardClick(uid, event)) {
          return;
        }
        controller.handleGroupClick(props.group, event);
      }}
      onContextMenu={(event) =>
        controller.handleContextMenu(props.group, event)
      }
      title={props.group.description || `Group ${props.group.identifiers.id}`}
    >
      <div class="font-bold text-neutral-200">{props.group.identifiers.id}</div>
      <Show
        when={
          props.group.identifiers.label ||
          controller.editingCardLabelUid() === props.group.identifiers.uid
        }
      >
        <div class="flex min-w-0 text-sm text-neutral-400">
          <CrudInlineLabelEditor
            ariaLabel="Group card label"
            class="truncate"
            editing={
              controller.editingCardLabelUid() === props.group.identifiers.uid
            }
            label={props.group.identifiers.label}
            onCancel={() => controller.setEditingCardLabelUid(null)}
            onCommit={(label) =>
              controller.updateGroupLabel(props.group, label)
            }
          >
            {props.group.identifiers.label}
          </CrudInlineLabelEditor>
        </div>
      </Show>
    </button>
  );
}

/** Renders the row-oriented group data grid. */
function GroupRowList(props: GroupsPanelViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.displayRows()}
        rowKey={(group) => group.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (group) => group.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 280,
            value: (group) => group.identifiers.label,
            onEdit: controller.updateGroupLabel,
          },
        ]}
        isRowSelected={(group) =>
          controller.selectedUidSet().has(group.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.setSelectedGroupUids(
            rows.map((group) => group.identifiers.uid),
          )
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={controller.handleGroupListRowClick}
        onRowContextMenu={(group, _modifiers, position) => {
          if (controller.isInteractionBlocked()) return;
          controller.openGroupContextMenu(group, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents group controls, dialogs, and list/card modes from controller props. */
export function GroupsPanelView(props: GroupsPanelViewProps) {
  const controller = props.controller;
  return (
    <div class="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add group (N)"}
              type="button"
              onClick={controller.handleCreate}
              label="Add group"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Edit selected group (Enter)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected group"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected groups (${controller.selectedCount()})`
                  : "Delete selected groups (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected groups"
            >
              <TrashIcon class="size-4" aria-hidden />
              <Show when={controller.selectedCount() > 0}>
                <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                  {controller.selectedCount()}
                </span>
              </Show>
            </ToolbarButton>
            <Show when={controller.viewMode() === "grid"}>
              <div class="mx-1 h-6 w-px bg-neutral-700" aria-hidden="true" />
              <ToolbarButton
                tooltip={`${controller.selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={controller.handleToggleSelectionMode}
                ariaPressed={controller.selectionMode()}
                label="Toggle selection mode"
              >
                <SelectionIcon class="size-4" aria-hidden />
              </ToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <CrudPanelSearch
              search={controller.search}
              placeholder="Search groups"
            />
            <CrudViewModeToggle
              viewMode={controller.viewMode()}
              onViewModeChange={controller.setViewMode}
            />
          </>
        }
      />
      <EntityEditorModal
        isOpen={controller.isCreateModalOpen()}
        title="Create group"
        submitLabel="Create"
        initialId={controller.createInitialId()}
        initialLabel={controller.createInitialLabel()}
        onCancel={() => controller.setIsCreateModalOpen(false)}
        onSubmit={controller.handleCreateSubmit}
      />
      <EntityEditorModal
        isOpen={controller.isEditModalOpen()}
        title="Edit group"
        submitLabel="Save"
        initialId={controller.editInitialId()}
        initialLabel={controller.editInitialLabel()}
        onCancel={() => controller.setIsEditModalOpen(false)}
        onSubmit={controller.handleEditSubmit}
      />
      <DeleteConfirmModal
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected groups"
        message={`Delete ${controller.selectedCount()} selected group(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />
      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Groups scroll area"
        classList={{
          "p-4": controller.viewMode() === "grid",
          relative: controller.viewMode() === "grid",
          "select-none":
            controller.selectionMode() && controller.viewMode() === "grid",
        }}
        onPointerDown={controller.gridDragSelection.onPointerDown}
        onPointerMove={controller.gridDragSelection.onPointerMove}
        onPointerUp={controller.gridDragSelection.onPointerUp}
        onPointerCancel={controller.gridDragSelection.onPointerCancel}
        onClick={(event) => {
          if (controller.gridDragSelection.consumeSuppressedClick()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          controller.gridClickSelection.handleBackgroundClick(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") return;
        }}
      >
        <Show
          when={controller.viewMode() === "grid"}
          fallback={<GroupRowList controller={controller} />}
        >
          <Show
            when={controller.displayRows().length > 0}
            fallback={
              <div class="py-8 text-center text-neutral-500">
                <Show
                  when={controller.allDisplayRows().length > 0}
                  fallback={
                    <>
                      <p>No groups defined</p>
                      <p class="mt-2 text-sm">
                        Use the add button in the toolbar to create a group
                      </p>
                    </>
                  }
                >
                  <p>No matching groups</p>
                </Show>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              <For each={controller.displayRows()}>
                {(group) => <GroupCard controller={controller} group={group} />}
              </For>
            </div>
          </Show>
        </Show>
        <Show
          when={
            controller.viewMode() === "grid" &&
            controller.gridDragSelection.dragBox()
          }
        >
          {(box) => (
            <div
              class={CRUD_GRID_DRAG_BOX_CLASS}
              data-crud-drag-box=""
              style={{
                left: `${box().left}px`,
                top: `${box().top}px`,
                width: `${box().width}px`,
                height: `${box().height}px`,
              }}
            />
          )}
        </Show>
      </CrudScrollArea>
    </div>
  );
}
