// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
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
import type { Timeline } from "../../../types";
import type { TimelineListController } from "../controllers/timeline-list-controller";
import {
  normalizeTimelineUid,
  timelineAudioLabel,
} from "../model/timeline-list-model";

interface TimelineListViewProps {
  controller: TimelineListController;
}

interface TimelineCardProps extends TimelineListViewProps {
  timeline: Timeline;
}

/** Renders one props-driven timeline card and its inline label editor. */
function TimelineCard(props: TimelineCardProps) {
  const controller = props.controller;
  const timelineUid = normalizeTimelineUid(props.timeline.identifiers.uid);
  /** Reports whether selection mode currently includes this card. */
  const isSelected = () =>
    controller.selectionMode() &&
    controller.selectedTimelineUidSet().has(timelineUid);

  return (
    <button
      type="button"
      aria-label={`Timeline ${props.timeline.identifiers.id}: ${props.timeline.identifiers.label}, ${timelineAudioLabel(props.timeline)}, ${props.timeline.tracks?.length ?? 0} tracks`}
      data-crud-select-id={timelineUid}
      onClick={(event) => controller.handleTimelineClick(props.timeline, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openTimelineContextMenu(
          props.timeline,
          event.clientX,
          event.clientY,
        );
      }}
      class={CRUD_CARD_CLASS}
      classList={{
        [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
        [CRUD_CARD_SELECTED_CLASS]: isSelected(),
      }}
      aria-pressed={isSelected()}
    >
      <div
        class="nf-timeline-card-title flex min-w-0 items-center"
        title={props.timeline.identifiers.label}
      >
        <CrudInlineLabelEditor
          ariaLabel="Timeline card label"
          class="min-w-0 truncate"
          editing={controller.editingCardLabelUid() === timelineUid}
          label={props.timeline.identifiers.label}
          onCancel={() => controller.setEditingCardLabelUid(null)}
          onCommit={(label) =>
            controller.updateTimelineLabel(props.timeline, label)
          }
        >
          {props.timeline.identifiers.label}
        </CrudInlineLabelEditor>
      </div>
      <div
        class="nf-timeline-card-audio truncate"
        title={timelineAudioLabel(props.timeline)}
      >
        {timelineAudioLabel(props.timeline)}
      </div>
      <div class="nf-timeline-card-meta flex items-center justify-between gap-2 whitespace-nowrap">
        <span class="min-w-0 truncate">
          Timeline {props.timeline.identifiers.id}
        </span>
        <span class="shrink-0">
          {props.timeline.tracks?.length ?? 0} track
          {props.timeline.tracks?.length !== 1 ? "s" : ""}
        </span>
      </div>
    </button>
  );
}

/** Renders timelines in the row-oriented editable data grid. */
function TimelineRowList(props: TimelineListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.timelineList()}
        rowKey={(timeline) => timeline.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (timeline) => timeline.identifiers.id,
          },
          {
            id: "label",
            title: "Label",
            width: 260,
            value: (timeline) => timeline.identifiers.label,
            onEdit: controller.updateTimelineLabel,
          },
          {
            id: "audio",
            title: "Audio",
            width: 220,
            value: timelineAudioLabel,
          },
          {
            id: "tracks",
            title: "Tracks",
            width: 90,
            value: (timeline) => timeline.tracks?.length ?? 0,
          },
        ]}
        isRowSelected={(timeline) =>
          controller
            .selectedTimelineUidSet()
            .has(normalizeTimelineUid(timeline.identifiers.uid))
        }
        onSelectionChange={(rows) =>
          controller.selectTimelines(
            rows.map((timeline) =>
              normalizeTimelineUid(timeline.identifiers.uid),
            ),
          )
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(timeline, modifiers) => {
          if (
            controller.isCreateModalOpen() ||
            controller.isEditModalOpen() ||
            controller.isDeleteModalOpen() ||
            !modifiers.altKey
          ) {
            return;
          }
          controller.openTimeline(timeline);
        }}
        onRowContextMenu={(timeline, _modifiers, position) => {
          if (
            controller.isCreateModalOpen() ||
            controller.isEditModalOpen() ||
            controller.isDeleteModalOpen()
          ) {
            return;
          }
          controller.openTimelineContextMenu(timeline, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents timeline-list controls, dialogs, and row/card modes from props. */
export function TimelineListView(props: TimelineListViewProps) {
  const controller = props.controller;
  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="timeline-list"
      data-panel-id={controller.panelId}
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add timeline (N)"}
              type="button"
              onClick={controller.handleCreate}
              label="Add timeline"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Open selected timeline (Enter)"}
              type="button"
              onClick={controller.handleOpenSelected}
              disabled={controller.selectedCount() !== 1}
              label="Open selected timeline"
            >
              <ArrowSquareOutIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Edit selected timeline (E)"}
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected timeline"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected timelines (${controller.selectedCount()})`
                  : "Delete selected timelines (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected timelines"
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
              placeholder="Search timelines"
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
        title="Create timeline"
        submitLabel="Create"
        initialId={controller.createInitialId()}
        initialLabel={`Timeline ${controller.createInitialId()}`}
        idLabel="Timeline ID"
        labelLabel="Timeline label"
        onCancel={() => controller.setIsCreateModalOpen(false)}
        onSubmit={controller.handleCreateSubmit}
      />
      <EntityEditorModal
        isOpen={controller.isEditModalOpen()}
        title="Edit timeline"
        submitLabel="Save"
        initialId={controller.editInitialId()}
        initialLabel={controller.editInitialLabel()}
        idLabel="Timeline ID"
        labelLabel="Timeline label"
        onCancel={() => {
          controller.setIsEditModalOpen(false);
          controller.setEditingTimelineUid(null);
        }}
        onSubmit={controller.handleEditSubmit}
      />
      <DeleteConfirmModal
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected timelines"
        message={`Delete ${controller.selectedCount()} selected timeline(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />

      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Timelines scroll area"
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
            when={controller.timelineList().length > 0}
            fallback={
              <div class="p-4 text-neutral-500">
                {controller.allTimelineList().length > 0
                  ? "No matching timelines"
                  : "No timelines available"}
              </div>
            }
          >
            <Show
              when={controller.viewMode() === "grid"}
              fallback={<TimelineRowList controller={controller} />}
            >
              <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                <For each={controller.timelineList()}>
                  {(timeline) => (
                    <TimelineCard controller={controller} timeline={timeline} />
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
            <div
              class={CRUD_GRID_DRAG_BOX_CLASS}
              data-crud-drag-box=""
              style={{
                left: `${controller.gridDragSelection.dragBox()?.left}px`,
                top: `${controller.gridDragSelection.dragBox()?.top}px`,
                width: `${controller.gridDragSelection.dragBox()?.width}px`,
                height: `${controller.gridDragSelection.dragBox()?.height}px`,
              }}
            />
          </Show>
        </div>
      </CrudScrollArea>
    </div>
  );
}
