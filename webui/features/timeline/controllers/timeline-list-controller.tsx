// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import { commandClient } from "../../../lib/engine-commands";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { focusExistingPanel } from "../../../lib/panel-open-command";
import {
  useConditionalShallowStore,
  useShallowStore,
} from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { dockApi, timecodes, timelines } from "../../../state/appStores";
import {
  type Timecode,
  type TimecodeCommand,
  TimecodeRate,
  TimecodeSource,
  type Timeline,
  type TimelineCommand,
  TimelineScrollMode,
} from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import {
  buildTimelineList,
  indexTimelinesByUid,
  nextTimelineId,
  normalizeTimelineUid,
  timelineExclusivelyOwnsTimecode,
} from "../model/timeline-list-model";

export interface TimelineListControllerProps {
  id?: string;
  initialPanelId: string;
}

/** Owns timeline-list stores, CRUD commands, selection, reveal, and shortcuts. */
export function createTimelineListController(
  props: TimelineListControllerProps,
) {
  const $timelines = useShallowStore(timelines);
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );
  const $dockApi = useStore(dockApi);
  const panelId = props.initialPanelId ?? props.id;
  const crud = createCrudListState<Timeline>({
    panelId,
    searchLabel: "Search timelines",
    viewModeKey: "timeline-list",
    orderedUids: (): readonly string[] => timelineIds(),
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
  const [editingTimelineUid, setEditingTimelineUid] = createSignal<
    string | null
  >(null);
  const [editInitialId, setEditInitialId] = createSignal(1);
  const [editInitialLabel, setEditInitialLabel] = createSignal("");

  /** Returns all timelines in stable display order before toolbar filtering. */
  const allTimelineList = createMemo(() => buildTimelineList($timelines()));

  /** Returns timelines matching the live toolbar search query. */
  const timelineList = createMemo(() =>
    allTimelineList().filter((timeline) =>
      search.matches([
        timeline.identifiers.id,
        timeline.identifiers.label,
        timeline.audio_path,
        timeline.tracks?.length ?? 0,
      ]),
    ),
  );

  /** Returns normalized timeline UIDs currently visible in the grid. */
  const timelineIds = createMemo(() =>
    timelineList().map((timeline) =>
      normalizeTimelineUid(timeline.identifiers.uid),
    ),
  );
  /** Indexes all timelines by normalized UID for selection and reveal. */
  const timelineListByUid = createMemo(() =>
    indexTimelinesByUid(allTimelineList()),
  );

  /** Resolves the first selected timeline, which the toolbar actions act on. */
  const selectedTimeline = createMemo(() =>
    timelineListByUid().get(crud.selectedUids()[0] ?? ""),
  );

  usePropertiesInspector(
    panelId,
    "Timeline",
    () => (
      <CrudLabelProperties
        entry={timelineListByUid().get(crud.propertiesUid() ?? "") ?? null}
        entityName="Timeline"
        getId={(timeline) => timeline.identifiers.id}
        getLabel={(timeline) => timeline.identifiers.label}
        onLabelCommit={(timeline, label) =>
          updateTimelineLabel(timeline, label)
        }
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Selects and reveals a timeline requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-TimelinesPanel",
    (request) => {
      const timeline = timelineListByUid().get(
        normalizeTimelineUid(request.uid),
      );
      if (!timeline) return;

      /** Reveals the requested timeline after any search reset settles. */
      const selectTimeline = () => {
        crud.revealRow(
          timeline,
          normalizeTimelineUid(timeline.identifiers.uid),
          request.requestId,
        );
      };

      if (!timelineList().includes(timeline) && search.isFiltering()) {
        search.clear();
        setTimeout(selectTimeline, 0);
      } else {
        selectTimeline();
      }
    },
    { accepts: (payload) => payload.type === "timeline" },
  );

  /** Sends a timeline mutation through the shared websocket transport. */
  const sendTimelineCommand = (command: TimelineCommand) => {
    commandClient.emit("TimelineCommand", command);
  };

  /** Sends a linked timecode mutation through the shared websocket transport. */
  const sendTimecodeCommand = (command: TimecodeCommand) => {
    commandClient.emit("TimecodeCommand", command);
  };

  /** Stores a timeline label change without changing timing content. */
  const updateTimelineLabel = (timeline: Timeline, label: string) => {
    if (label === timeline.identifiers.label) return;
    sendTimelineCommand({
      type: "StoreTimeline",
      data: {
        ...timeline,
        identifiers: {
          ...timeline.identifiers,
          label,
        },
      },
    });
  };

  /** Requests inline editing for the selected timeline label cell. */
  const requestTimelineLabelEdit = (timeline: Timeline) =>
    crud.requestLabelEdit(
      normalizeTimelineUid(timeline.identifiers.uid),
      () => timeline,
    );

  /** Resolves an internal timecode that can safely mirror timeline edits. */
  const editableLinkedTimecode = (timeline: Timeline): Timecode | undefined => {
    const timecode = $timecodes()[timeline.timecode_uid]?.[0];
    if (!timecode) return undefined;
    if (timecode.source !== TimecodeSource.Internal) return undefined;
    if (!timelineExclusivelyOwnsTimecode(allTimelineList(), timeline)) {
      return undefined;
    }
    return timecode;
  };

  /** Opens or focuses the editor panel for a timeline. */
  const openTimeline = (timeline: Timeline) => {
    const api = $dockApi();
    if (!api) return;

    const timelineUid = normalizeTimelineUid(timeline.identifiers.uid);
    const panelId = `panel-Timeline-${timelineUid}`;
    if (focusExistingPanel(api, panelId)) return;
    api.addPanel({
      id: panelId,
      component: "Timeline",
      title: `Timeline ${timeline.identifiers.id}`,
      params: { initialTimelineUid: timelineUid },
    });
  };

  /** Selects a timeline before opening its context menu. */
  const selectForContextMenu = (timeline: Timeline) =>
    crud.selectForContextMenu(normalizeTimelineUid(timeline.identifiers.uid));

  /** Opens timeline row actions, including inline label rename. */
  const openTimelineContextMenu = (
    timeline: Timeline,
    x: number,
    y: number,
  ) => {
    selectForContextMenu(timeline);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-timeline",
          label: "Open Timeline",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          onSelect: () => openTimeline(timeline),
        },
        {
          id: "rename-timeline",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestTimelineLabelEdit(timeline),
        },
        { id: "timeline-menu-separator", type: "separator" },
        {
          id: "delete-timeline",
          label:
            crud.selectedCount() > 1
              ? `Delete ${crud.selectedCount()} Timelines`
              : "Delete Timeline",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: crud.requestDelete,
        },
      ],
    });
  };

  /** Selects a timeline card or opens it when selection mode does not consume the click. */
  const handleTimelineClick = (timeline: Timeline, event: MouseEvent) => {
    if (crud.dialogOpen()) return;
    const timelineUid = normalizeTimelineUid(timeline.identifiers.uid);
    if (crud.gridClickSelection.handleCardClick(timelineUid, event)) return;
    openTimeline(timeline);
  };

  /** Opens the sole selected timeline and exits selection mode. */
  const handleOpenSelected = () => {
    if (
      crud.selectedCount() !== 1 ||
      isCreateModalOpen() ||
      isEditModalOpen()
    ) {
      return;
    }
    const timeline = selectedTimeline();
    if (!timeline) return;
    openTimeline(timeline);
    crud.setSelectionModeEnabled(false);
  };

  /** Opens the timeline creation dialog with the next available identifier. */
  const handleCreate = () => {
    if (isEditModalOpen() || crud.isDeleteModalOpen()) return;
    setCreateInitialId(nextTimelineId(allTimelineList()));
    setIsCreateModalOpen(true);
  };

  /** Creates linked timeline and internal-timecode records from dialog values. */
  const handleCreateSubmit = (payload: { id: number; label: string }) => {
    const timelineUid = normalizeTimelineUid(uuidv4());
    const timecodeUid = normalizeTimelineUid(uuidv4());
    const timecode = {
      identifiers: {
        id: payload.id,
        uid: timecodeUid,
        label: payload.label,
      },
      rate: TimecodeRate.Fps30,
      source: TimecodeSource.Internal,
    };
    const timeline: Timeline = {
      identifiers: {
        id: payload.id,
        uid: timelineUid,
        label: payload.label,
      },
      timecode_uid: timecodeUid,
      timecode_start: { secs: 0, nanos: 0 },
      audio_path: "",
      audio_enabled: true,
      end_time: undefined,
      tracks: [],
      markers: [],
      regions: [],
      loop_range: undefined,
      bpm: 120,
      beats_per_bar: 4,
      use_beat_grid: false,
      beatgrid: undefined,
      scroll_mode: TimelineScrollMode.Free,
    };

    sendTimecodeCommand({ type: "StoreTimecode", data: timecode });
    sendTimelineCommand({ type: "StoreTimeline", data: timeline });
    crud.clearSelection();
    setIsCreateModalOpen(false);
    setTimeout(() => openTimeline(timeline), 100);
  };

  /** Opens the editor dialog for the sole selected timeline. */
  const handleEditSelected = () => {
    if (isCreateModalOpen() || crud.isDeleteModalOpen()) return;
    if (crud.selectedCount() !== 1) return;
    const timeline = selectedTimeline();
    if (!timeline) return;

    setEditingTimelineUid(normalizeTimelineUid(timeline.identifiers.uid));
    setEditInitialId(timeline.identifiers.id);
    setEditInitialLabel(timeline.identifiers.label);
    setIsEditModalOpen(true);
    crud.setSelectionModeEnabled(false);
  };

  /** Applies timeline identity edits and mirrors safe linked-timecode fields. */
  const handleEditSubmit = (payload: { id: number; label: string }) => {
    const timelineUid = editingTimelineUid();
    if (!timelineUid) {
      setIsEditModalOpen(false);
      return;
    }

    const timeline = allTimelineList().find(
      (candidate) =>
        normalizeTimelineUid(candidate.identifiers.uid) === timelineUid,
    );
    if (!timeline) {
      setIsEditModalOpen(false);
      return;
    }

    const linkedTimecode = editableLinkedTimecode(timeline);
    const timelineIdChanged = payload.id !== timeline.identifiers.id;
    const timelineLabelChanged = payload.label !== timeline.identifiers.label;

    if (timelineIdChanged) {
      sendTimelineCommand({
        type: "RenameTimeline",
        data: { id: timeline.identifiers.id, new_id: payload.id },
      });
    }

    if (linkedTimecode && timelineIdChanged) {
      sendTimecodeCommand({
        type: "RenameTimecode",
        data: { id: linkedTimecode.identifiers.id, new_id: payload.id },
      });
    }

    if (linkedTimecode && (timelineIdChanged || timelineLabelChanged)) {
      sendTimecodeCommand({
        type: "StoreTimecode",
        data: {
          ...linkedTimecode,
          identifiers: {
            ...linkedTimecode.identifiers,
            id: payload.id,
            label: payload.label,
          },
        },
      });
    }

    if (timelineIdChanged || timelineLabelChanged) {
      sendTimelineCommand({
        type: "StoreTimeline",
        data: {
          ...timeline,
          identifiers: {
            ...timeline.identifiers,
            id: payload.id,
            label: payload.label,
          },
        },
      });
    }

    setIsEditModalOpen(false);
    setEditingTimelineUid(null);
  };

  /** Deletes each selected timeline after confirmation. */
  const confirmDeleteSelected = () =>
    crud.confirmDelete((timelineUid) => {
      const timeline = allTimelineList().find(
        (candidate) =>
          normalizeTimelineUid(candidate.identifiers.uid) === timelineUid,
      );
      if (!timeline) return;
      sendTimelineCommand({
        type: "DeleteTimeline",
        data: timeline.identifiers.id,
      });
    });

  useKeyboardShortcut({
    key: "n",
    handler: handleCreate,
    description: "Create timeline",
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
    handler: handleOpenSelected,
    description: "Open selected timeline",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "e",
    handler: handleEditSelected,
    description: "Edit selected timeline",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: crud.requestDelete,
    description: "Delete selected timelines",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: crud.requestDelete,
    description: "Delete selected timelines",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: crud.handleEscape,
    description: "Clear selected timelines",
    componentId: panelId,
  });

  return {
    panelId,
    crud,
    isCreateModalOpen,
    setIsCreateModalOpen,
    isEditModalOpen,
    setIsEditModalOpen,
    createInitialId,
    editInitialId,
    editInitialLabel,
    setEditingTimelineUid,
    allTimelineList,
    timelineList,
    updateTimelineLabel,
    openTimeline,
    openTimelineContextMenu,
    handleTimelineClick,
    handleOpenSelected,
    handleCreate,
    handleCreateSubmit,
    handleEditSelected,
    handleEditSubmit,
    confirmDeleteSelected,
  };
}

export type TimelineListController = ReturnType<
  typeof createTimelineListController
>;
