// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { ListDashesIcon } from "@squidlab/phosphor-solid/list-dashes";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { SparkleIcon } from "@squidlab/phosphor-solid/sparkle";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "../../../components/ui/dropdown-menu";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import Tooltip from "../../../components/ui/tooltip";
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
import type { FxListController } from "../controllers/fx-list-controller";
import type { FxListEntry } from "../model/fx-list-model";
import { ModuleFxDialog } from "./fx-list-dialogs";

interface FxListViewProps {
  controller: FxListController;
}

interface FxCardProps extends FxListViewProps {
  entry: FxListEntry;
}

/** Renders one props-driven FX card with type and selection presentation. */
function FxCard(props: FxCardProps) {
  const controller = props.controller;
  /** Reports whether this FX entry belongs to the current selection. */
  const isSelected = () =>
    controller.selectedFxUidSet().has(props.entry.identifiers.uid);
  return (
    <button
      type="button"
      data-crud-select-id={props.entry.identifiers.uid}
      onClick={(event) => {
        if (controller.gridDragSelection.consumeSuppressedClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          controller.gridClickSelection.handleCardClick(
            props.entry.identifiers.uid,
            event,
          )
        )
          return;
        controller.handleFxItemClick(props.entry.identifiers.uid);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openFxContextMenu(props.entry, event.clientX, event.clientY);
      }}
      class={CRUD_CARD_CLASS}
      classList={{
        [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
        [CRUD_CARD_SELECTED_CLASS]: isSelected(),
      }}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
          <span>{props.entry.identifiers.id}:</span>
          <CrudInlineLabelEditor
            ariaLabel="FX card label"
            class="truncate"
            editing={
              controller.editingCardLabelUid() === props.entry.identifiers.uid
            }
            label={props.entry.identifiers.label}
            onCancel={() => controller.setEditingCardLabelUid(null)}
            onCommit={(label) =>
              controller.updateFxEntryLabel(props.entry, label)
            }
          >
            {props.entry.identifiers.label}
          </CrudInlineLabelEditor>
        </div>
        <div
          class="rounded-md border border-neutral-700 bg-neutral-900/70 p-1 text-neutral-300"
          title={`${props.entry.typeLabel} FX`}
        >
          <Dynamic
            component={props.entry.typeIcon}
            class="size-4"
            aria-hidden
          />
        </div>
      </div>
      <div class="text-xs text-neutral-400 mt-1">
        {props.entry.typeLabel} FX
      </div>
      <div class="text-xs text-neutral-500 mt-1">{props.entry.detail}</div>
    </button>
  );
}

/** Renders the row-oriented mixed FX data grid. */
function FxRowList(props: FxListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.visibleFxList()}
        rowKey={(entry) => entry.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (entry) => entry.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 260,
            value: (entry) => entry.identifiers.label,
            onEdit: controller.updateFxEntryLabel,
          },
          {
            id: "type",
            title: "Type",
            width: 110,
            value: (entry) => entry.typeLabel,
          },
          {
            id: "detail",
            title: "Details",
            width: 180,
            value: (entry) => entry.detail,
          },
        ]}
        isRowSelected={(entry) =>
          controller.selectedFxUidSet().has(entry.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.setSelectedFxUids(
            rows.map((entry) => entry.identifiers.uid),
          )
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(entry, modifiers) => {
          if (controller.isDeleteModalOpen() || !modifiers.altKey) return;
          controller.openFxEntry(entry);
        }}
        onRowContextMenu={(entry, _modifiers, position) => {
          if (controller.isDeleteModalOpen()) return;
          controller.openFxContextMenu(entry, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents FX-list controls, dialogs, and list/card modes from props. */
export function FxListView(props: FxListViewProps) {
  const controller = props.controller;
  return (
    <div class="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <DropdownMenu
              align="start"
              placement="below"
              triggerLabel="Add effect"
              trigger={
                <Tooltip content={() => "Add effect"}>
                  <span class="inline-flex items-center gap-1">
                    <PlusIcon class="size-4" aria-hidden />
                    <CaretDownIcon class="size-3" aria-hidden />
                  </span>
                </Tooltip>
              }
            >
              <DropdownMenuItem
                icon={SparkleIcon}
                onClick={controller.handleCreateRegular}
              >
                Regular FX
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={ListDashesIcon}
                onClick={controller.handleCreateStep}
              >
                Step FX
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={CubeIcon}
                onClick={controller.handleCreateModule}
              >
                Module FX
              </DropdownMenuItem>
            </DropdownMenu>
            <ToolbarButton
              tooltip={"Edit selected effect (Enter)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={!controller.canEditSelected()}
              label="Edit selected effect"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected effects (${controller.selectedCount()})`
                  : "Delete selected effects (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={!controller.canDeleteSelected()}
              label="Delete selected effects"
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
              placeholder="Search FX"
            />
            <CrudViewModeToggle
              viewMode={controller.viewMode()}
              onViewModeChange={controller.setViewMode}
            />
          </>
        }
      />
      <DeleteConfirmModal
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected effects"
        message={`Delete ${controller.selectedCount()} selected effect(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />
      <ModuleFxDialog
        isOpen={controller.isModuleDialogOpen()}
        modules={controller.availableFxModules()}
        nextId={controller.nextAvailableFxId()}
        onCancel={() => controller.setIsModuleDialogOpen(false)}
        onCreate={controller.handleModuleDialogCreate}
      />
      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="FX scroll area"
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
          fallback={<FxRowList controller={controller} />}
        >
          <Show
            when={controller.visibleFxList().length > 0}
            fallback={
              <div class="text-neutral-500 text-center py-8">
                <Show
                  when={controller.fxList().length > 0}
                  fallback={
                    <>
                      <p>No FX defined</p>
                      <p class="text-sm mt-2">
                        Use the add button in the toolbar to create your first
                        effect
                      </p>
                    </>
                  }
                >
                  <p>No matching FX</p>
                </Show>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              <For each={controller.visibleFxList()}>
                {(entry) => <FxCard controller={controller} entry={entry} />}
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
