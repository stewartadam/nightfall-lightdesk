// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
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
import type { Sequence } from "../../../types";
import type { SequenceListController } from "../controllers/sequence-list-controller";
import { normalizeSequenceUid } from "../model/sequence-list-model";
import SequenceWrapTag from "./sequence-wrap-tag";

interface SequenceListViewProps {
  controller: SequenceListController;
}

interface SequenceCardProps extends SequenceListViewProps {
  sequence: Sequence;
}

/** Renders one props-driven sequence card with selection and inline editing. */
function SequenceCard(props: SequenceCardProps) {
  const controller = props.controller;
  const sequenceUid = normalizeSequenceUid(props.sequence.identifiers.uid);
  /** Reports whether the card is active under the current interaction mode. */
  const isSelected = () =>
    controller.selectionMode()
      ? controller.selectedSequenceUidSet().has(sequenceUid)
      : controller.selectedSequenceUid() === sequenceUid;
  return (
    <button
      type="button"
      data-crud-select-id={sequenceUid}
      ref={(element) => controller.registerSequenceButton(sequenceUid, element)}
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
        if (controller.gridClickSelection.handleCardClick(sequenceUid, event))
          return;
        controller.handleSequenceItemClick(props.sequence);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openSequenceContextMenu(
          props.sequence,
          event.clientX,
          event.clientY,
        );
      }}
    >
      <div class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
        <span>{props.sequence.identifiers.id}:</span>
        <CrudInlineLabelEditor
          ariaLabel="Sequence card label"
          class="truncate"
          editing={controller.editingCardLabelUid() === sequenceUid}
          label={props.sequence.identifiers.label}
          onCancel={() => controller.setEditingCardLabelUid(null)}
          onCommit={(label) =>
            controller.updateSequenceLabel(props.sequence, label)
          }
        >
          {props.sequence.identifiers.label}
        </CrudInlineLabelEditor>
        <Show when={props.sequence.wrap}>
          <SequenceWrapTag />
        </Show>
      </div>
      <div class="mt-1 text-xs text-neutral-400">
        {props.sequence.steps.length} cue
        {props.sequence.steps.length !== 1 ? "s" : ""}
      </div>
    </button>
  );
}

/** Renders the row-oriented sequence data grid. */
function SequenceRowList(props: SequenceListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.displayRows()}
        rowKey={(sequence) => sequence.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (sequence) => sequence.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 260,
            value: (sequence) => sequence.identifiers.label,
            onEdit: controller.updateSequenceLabel,
          },
          {
            id: "cues",
            title: "Cues",
            width: 90,
            value: (sequence) => sequence.steps.length,
          },
        ]}
        isRowSelected={(sequence) =>
          controller
            .selectedSequenceUidSet()
            .has(normalizeSequenceUid(sequence.identifiers.uid))
        }
        onSelectionChange={(rows) => {
          const selectedUids = rows.map((sequence) =>
            normalizeSequenceUid(sequence.identifiers.uid),
          );
          controller.setSelectedSequenceUids(selectedUids);
          controller.setSelectedSequenceUid(selectedUids[0] ?? null);
        }}
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(sequence, modifiers) => {
          if (controller.isDeleteModalOpen() || !modifiers.altKey) return;
          controller.openSequenceEditor(sequence);
        }}
        onRowContextMenu={(sequence, _modifiers, position) => {
          if (controller.isDeleteModalOpen()) return;
          controller.openSequenceContextMenu(sequence, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents sequence-list controls and list/card modes from controller props. */
export function SequenceListView(props: SequenceListViewProps) {
  const controller = props.controller;
  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="sequence-list"
      data-panel-id={controller.panelId}
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add sequence (N)"}
              type="button"
              onClick={controller.handleCreate}
              label="Add sequence"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Edit selected sequence (Enter)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected sequence"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Duplicate selected sequence (Cmd/Ctrl+D)"}
              type="button"
              onClick={controller.handleDuplicateSelected}
              disabled={controller.selectedCount() !== 1}
              label="Duplicate selected sequence"
            >
              <CopySimpleIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected sequences (${controller.selectedCount()})`
                  : "Delete selected sequences (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected sequences"
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
              placeholder="Search sequences"
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
        title="Delete selected sequences"
        message={`Delete ${controller.selectedCount()} selected sequence(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />
      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Sequences scroll area"
      >
        <div
          class="min-h-0 min-h-full"
          classList={{
            "h-full": controller.viewMode() !== "grid",
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
            when={controller.displayRows().length > 0}
            fallback={
              <div class="text-neutral-500">
                {controller.allDisplayRows().length > 0
                  ? "No matching sequences"
                  : "Loading sequences..."}
              </div>
            }
          >
            <Show
              when={controller.viewMode() === "grid"}
              fallback={<SequenceRowList controller={controller} />}
            >
              <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                <For each={controller.displayRows()}>
                  {(sequence) => (
                    <SequenceCard controller={controller} sequence={sequence} />
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
      </CrudScrollArea>
    </div>
  );
}
