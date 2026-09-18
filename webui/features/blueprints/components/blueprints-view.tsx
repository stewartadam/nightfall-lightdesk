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
import CrudViewModeToggle, {
  createCrudViewEntrance,
} from "../../../components/widgets/crud/crud-view-mode-toggle";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../../../components/widgets/entity-editor-dialog";
import type { Blueprint } from "../../../types";
import type { BlueprintsController } from "../controllers/blueprints-controller";

interface BlueprintsViewProps {
  controller: BlueprintsController;
}

interface BlueprintCardProps extends BlueprintsViewProps {
  blueprint: Blueprint;
}

/** Renders one props-driven blueprint card with contents and dependency metadata. */
function BlueprintCard(props: BlueprintCardProps) {
  const controller = props.controller;
  const uid = props.blueprint.identifiers.uid;
  /** Reports whether this blueprint belongs to the current selection. */
  const isSelected = () => controller.selectedUidSet().has(uid);
  /** Returns the current logical attributes contained by this Blueprint. */
  const attributeGroups = () =>
    controller.blueprintAttributeGroups(props.blueprint);
  /** Returns the current authored objects depending on this Blueprint. */
  const dependents = () => controller.blueprintDependents(uid);
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
        if (controller.gridClickSelection.handleCardClick(uid, event)) return;
        controller.handleBlueprintClick(uid);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openBlueprintContextMenu(
          props.blueprint,
          event.clientX,
          event.clientY,
        );
      }}
      title={`Blueprint ${props.blueprint.identifiers.id}: ${props.blueprint.identifiers.label}`}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
          <span>{props.blueprint.identifiers.id}:</span>
          <CrudInlineLabelEditor
            ariaLabel="Blueprint card label"
            class="truncate"
            editing={controller.editingCardLabelUid() === uid}
            label={props.blueprint.identifiers.label}
            onCancel={() => controller.setEditingCardLabelUid(null)}
            onCommit={(label) =>
              controller.updateBlueprintLabel(props.blueprint, label)
            }
          >
            {props.blueprint.identifiers.label}
          </CrudInlineLabelEditor>
        </span>
        <Show when={dependents().length > 0}>
          <span class="rounded border border-emerald-500/40 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-100">
            Referenced
          </span>
        </Show>
      </div>
      <div class="mt-2 space-y-0.5 text-left text-[10px] text-neutral-400">
        <Show when={attributeGroups().length > 0} fallback="No attributes">
          <For each={attributeGroups()}>
            {(group) => (
              <div class="truncate">
                <span class="text-neutral-300">{group.category}:</span>{" "}
                {group.attributes.join(", ")}
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="mt-2 flex justify-end text-[10px] text-neutral-400">
        <span class="shrink-0">
          {dependents().length} ref{dependents().length === 1 ? "" : "s"}
        </span>
      </div>
    </button>
  );
}

/** Renders the row-oriented blueprint data grid. */
function BlueprintRowList(props: BlueprintsViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.displayRows()}
        rowKey={(blueprint) => blueprint.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (blueprint) => blueprint.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 260,
            value: (blueprint) => blueprint.identifiers.label,
            onEdit: controller.updateBlueprintLabel,
          },
          {
            id: "attributes",
            title: "Attributes",
            width: 220,
            value: (blueprint) =>
              controller
                .blueprintAttributeGroups(blueprint)
                .map(
                  (group) =>
                    `${group.category}: ${group.attributes.join(", ")}`,
                )
                .join(" · ") || "—",
          },
          {
            id: "references",
            title: "Refs",
            width: 70,
            value: (blueprint) =>
              controller.blueprintDependents(blueprint.identifiers.uid).length,
          },
        ]}
        isRowSelected={(blueprint) =>
          controller.selectedUidSet().has(blueprint.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.setSelectedBlueprintUids(
            rows.map((blueprint) => blueprint.identifiers.uid),
          )
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(blueprint, modifiers) => {
          if (
            controller.isDeleteModalOpen() ||
            controller.isCreateModalOpen() ||
            controller.isEditModalOpen() ||
            !modifiers.altKey
          )
            return;
          controller.recallBlueprint(blueprint);
        }}
        onRowContextMenu={(blueprint, _modifiers, position) => {
          if (
            controller.isDeleteModalOpen() ||
            controller.isCreateModalOpen() ||
            controller.isEditModalOpen()
          )
            return;
          controller.openBlueprintContextMenu(
            blueprint,
            position.x,
            position.y,
          );
        }}
      />
    </div>
  );
}

/** Presents blueprint controls, dialogs, and list/card modes from props. */
export function BlueprintsView(props: BlueprintsViewProps) {
  let viewContent: HTMLDivElement | undefined;
  createCrudViewEntrance(
    () => props.controller.viewMode(),
    () => viewContent,
  );
  const controller = props.controller;
  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="blueprints"
      data-panel-id={controller.panelId}
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add blueprint (N)"}
              type="button"
              onClick={controller.handleCreate}
              label="Add blueprint"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Edit selected blueprint (Enter)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected blueprint"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Store programmer into selected Blueprint"}
              type="button"
              onClick={controller.handleStoreSelected}
              disabled={controller.selectedCount() !== 1}
              label="Store programmer into selected Blueprint"
            >
              <FloppyDiskIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Duplicate selected Blueprint"}
              type="button"
              onClick={controller.handleDuplicateSelected}
              disabled={controller.selectedCount() !== 1}
              label="Duplicate selected Blueprint"
            >
              <CopySimpleIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected blueprints (${controller.selectedCount()})`
                  : "Delete selected blueprints (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected blueprints"
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
              placeholder="Search blueprints"
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
        title="Create blueprint"
        submitLabel="Create"
        initialId={controller.createInitialId()}
        initialLabel={controller.createInitialLabel()}
        onCancel={() => controller.setIsCreateModalOpen(false)}
        onSubmit={controller.handleCreateSubmit}
      />
      <EntityEditorModal
        isOpen={controller.isEditModalOpen()}
        title="Edit blueprint"
        submitLabel="Save"
        initialId={controller.editInitialId()}
        initialLabel={controller.editInitialLabel()}
        onCancel={() => controller.setIsEditModalOpen(false)}
        onSubmit={controller.handleEditSubmit}
      />
      <DeleteConfirmModal
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected blueprints"
        message={`Delete ${controller.selectedCount()} selected blueprint(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />
      <div
        ref={viewContent}
        class="min-h-0 flex-1 overflow-auto"
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
          fallback={<BlueprintRowList controller={controller} />}
        >
          <Show
            when={controller.displayRows().length > 0}
            fallback={
              <div class="py-8 text-center text-neutral-500">
                <Show
                  when={controller.allDisplayRows().length > 0}
                  fallback={
                    <>
                      <p>No blueprints defined</p>
                      <p class="mt-2 text-sm">
                        Use the add button in the toolbar to create a blueprint
                      </p>
                    </>
                  }
                >
                  <p>No matching blueprints</p>
                </Show>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              <For each={controller.displayRows()}>
                {(blueprint) => (
                  <BlueprintCard
                    controller={controller}
                    blueprint={blueprint}
                  />
                )}
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
      </div>
    </div>
  );
}

import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { FloppyDiskIcon } from "@squidlab/phosphor-solid/floppy-disk";
