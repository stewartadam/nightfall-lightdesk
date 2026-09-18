// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
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
  CRUD_SECTION_CLASS,
  CRUD_SECTION_SUMMARY_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudScrollArea from "../../../components/widgets/crud/crud-scroll-area";
import CrudViewModeToggle from "../../../components/widgets/crud/crud-view-mode-toggle";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { GridCellKind } from "../../../lib/data-grid-types";
import type { Cue } from "../../../types";
import type { CueListController } from "../controllers/cue-list-controller";
import type { CueListDisplayRow } from "../model/cue-list-model";

interface CueListViewProps {
  controller: CueListController;
}

interface CueCardProps extends CueListViewProps {
  cue: Cue;
}

/** Renders one props-driven cue card with selection and inline-label behavior. */
function CueCard(props: CueCardProps) {
  const controller = props.controller;
  const cueUid = props.cue.identifiers.uid.toString();
  /** Reports whether this cue belongs to the current selection. */
  const isSelected = () => controller.selectedCueUidSet().has(cueUid);
  return (
    <button
      type="button"
      data-crud-select-id={cueUid}
      draggable={!controller.selectionMode()}
      onClick={(event) => {
        if (controller.gridDragSelection.consumeSuppressedClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (controller.gridClickSelection.handleCardClick(cueUid, event))
          return;
        controller.handleCueItemClick(cueUid);
      }}
      onDragStart={(event) => controller.handleDragStart(event, props.cue)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openCueContextMenu(props.cue, event.clientX, event.clientY);
      }}
      class={CRUD_CARD_CLASS}
      classList={{
        [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
        [CRUD_CARD_SELECTED_CLASS]: isSelected(),
      }}
    >
      <span class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
        <span>{props.cue.identifiers.id}:</span>
        <CrudInlineLabelEditor
          ariaLabel="Cue card label"
          class="truncate"
          editing={controller.editingCardLabelUid() === cueUid}
          label={props.cue.identifiers.label}
          onCancel={() => controller.setEditingCardLabelUid(null)}
          onCommit={(label) => controller.updateCueLabel(props.cue, label)}
        >
          {props.cue.identifiers.label}
        </CrudInlineLabelEditor>
      </span>
    </button>
  );
}

/** Renders one titled group of cue cards. */
function CueCardSection(
  props: CueListViewProps & { title: string; cues: Cue[] },
) {
  return (
    <details open class={CRUD_SECTION_CLASS}>
      <summary class={CRUD_SECTION_SUMMARY_CLASS}>
        <span class="font-medium text-neutral-200">{props.title}</span>
        <span class="text-xs text-neutral-400">
          {props.cues.length} cue{props.cues.length !== 1 ? "s" : ""}
        </span>
      </summary>
      <div class="p-3">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          <For each={props.cues}>
            {(cue) => <CueCard controller={props.controller} cue={cue} />}
          </For>
        </div>
      </div>
    </details>
  );
}

/** Renders grouped cue cards for the grid presentation. */
function CueCardGrid(props: CueListViewProps) {
  return (
    <div>
      <For each={props.controller.groupedData().sequencesWithCues}>
        {(entry) => (
          <CueCardSection
            controller={props.controller}
            title={`Sequence ${entry.sequence.identifiers.id}: ${entry.sequence.identifiers.label}`}
            cues={entry.cues}
          />
        )}
      </For>
      <Show when={props.controller.groupedData().ungroupedCues.length > 0}>
        <CueCardSection
          controller={props.controller}
          title="Ungrouped Cues"
          cues={props.controller.groupedData().ungroupedCues}
        />
      </Show>
    </div>
  );
}

/** Renders the row-oriented cue list data grid. */
function CueRowList(props: CueListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rowMarkers="none"
        rowSelectionOnly
        rows={controller.cueListRows()}
        rowKey={(row) =>
          row.rowKind === "group"
            ? `group:${row.groupKey}`
            : `cue:${row.cueUid}`
        }
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "marker",
            title: "",
            width: 36,
            cell: (row) =>
              row.rowKind === "group"
                ? {
                    kind: GridCellKind.Text,
                    data: row.isCollapsed ? "▶" : "▼",
                    displayData: row.isCollapsed ? "▶" : "▼",
                    allowOverlay: false,
                  }
                : {
                    kind: GridCellKind.Boolean,
                    data: controller.selectedCueUidSet().has(row.cueUid),
                    allowOverlay: false,
                    readonly: true,
                  },
          },
          {
            id: "id",
            title: "ID",
            width: 80,
            value: (row) =>
              row.rowKind === "group"
                ? (row.sequenceId ?? "")
                : row.sequenceId === null
                  ? row.cue.identifiers.id
                  : `${row.sequenceId}.${row.cue.identifiers.id}`,
          },
          {
            id: "label",
            title: "Label",
            width: 320,
            value: (row) =>
              row.rowKind === "group"
                ? row.title
                : `  ${row.cue.identifiers.label}`,
            onEdit: (row, label) => {
              if (row.rowKind === "cue")
                controller.updateCueLabel(row.cue, label.trimStart());
            },
          },
          {
            id: "cues",
            title: "Cues",
            width: 90,
            value: (row) => (row.rowKind === "group" ? row.cueCount : ""),
          },
        ]}
        isRowSelectable={(row) => row.rowKind === "cue"}
        isRowSelected={(row) =>
          row.rowKind === "cue" &&
          controller.selectedCueUidSet().has(row.cueUid)
        }
        onDeleteRequested={controller.handleDeleteSelected}
        onActiveRowChange={controller.setActiveCueListRow}
        onSelectionChange={(rows: CueListDisplayRow[]) =>
          controller.setSelectedCueUids(
            rows.flatMap((row) => (row.rowKind === "cue" ? [row.cueUid] : [])),
          )
        }
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(row, modifiers) => {
          if (controller.isDeleteModalOpen()) return;
          if (row.rowKind === "group")
            controller.toggleGroupCollapsed(row.groupKey);
          else if (modifiers.altKey) controller.openCueEditor(row.cueUid);
        }}
        onRowContextMenu={(row, _modifiers, position) => {
          if (controller.isDeleteModalOpen()) return;
          if (row.rowKind === "group")
            controller.openCueGroupContextMenu(row, position.x, position.y);
          else controller.openCueContextMenu(row.cue, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents cue-list toolbar, confirmation state, and list/card modes from props. */
export function CueListView(props: CueListViewProps) {
  const controller = props.controller;
  return (
    <div ref={controller.setPanelRootRef} class="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Edit selected cue (Enter)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected cue"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected cues (${controller.selectedCount()})`
                  : "Delete selected cues (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected cues"
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
              placeholder="Search cues"
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
        title="Delete selected cues"
        message={`Delete ${controller.selectedCount()} selected cue(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />
      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Cues scroll area"
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
          when={
            Object.keys(controller.cues()).length > 0 &&
            controller.cueGroups().length > 0
          }
          fallback={
            <div class="text-neutral-500">
              {Object.keys(controller.cues()).length > 0
                ? "No matching cues"
                : "Loading cues..."}
            </div>
          }
        >
          <Show
            when={controller.viewMode() === "grid"}
            fallback={<CueRowList controller={controller} />}
          >
            <CueCardGrid controller={controller} />
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
