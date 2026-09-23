// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
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
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import {
  serializeTimelineInsertDragPayload,
  TIMELINE_INSERT_DRAG_MIME,
} from "../../../lib/timeline-insert-drag";
import { clips, dockApi } from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { ClipControlsSection } from "../components/clip-controls-section";
import { ClipEditorDialogs } from "../components/clip-editor-dialogs";
import { ClipListToolbar } from "../components/clip-list-toolbar";
import { ClipListView } from "../components/clip-list-view";
import ClipProperties from "../components/clip-properties";
import { toggleClipPlayback } from "../services/clip-commands";
import { createClipControlsController } from "./clip-controls-controller";
import { createClipCrudController } from "./clip-crud-controller";

interface ClipListControllerProps {
  panelId: string;
}

/** Coordinates clip stores, CRUD interactions, selection, and presentation. */
export function ClipListController(props: ClipListControllerProps) {
  const $dockApi = useStore(dockApi);
  const $clips = useStore(clips);
  const panelId = props.panelId;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search clips",
  });
  let panelRootRef: HTMLDivElement | undefined;

  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("clips-list"),
  );
  const [selectedClipUids, setSelectedClipUids] = createSignal<string[]>([]);
  const [inspectedClipUid, setInspectedClipUid] = createSignal<string | null>(
    null,
  );

  const selectedCount = createMemo(() => selectedClipUids().length);
  const selectedUidSet = createMemo(() => new Set(selectedClipUids()));
  const controls = createClipControlsController(() => panelRootRef);
  const propertiesClipUid = createMemo(() => {
    if (selectedCount() === 1) {
      return selectedClipUids()[0] ?? null;
    }
    if (selectedCount() > 1) return null;
    return inspectedClipUid();
  });

  const clipPropertiesInspector = usePropertiesInspector(
    panelId,
    "Clip",
    () => <ClipProperties clipUid={propertiesClipUid()} />,
    { priority: 10, autoActivate: true },
  );

  /** Returns all clip entries in stable display order before filtering. */
  const allDisplayRows = createMemo(() =>
    Object.values($clips()).sort(
      (a, b) => a[0].identifiers.id - b[0].identifiers.id,
    ),
  );

  /** Returns clip entries matching the live toolbar search query. */
  const displayRows = createMemo(() =>
    allDisplayRows().filter(([clip, isActive]) =>
      search.matches([
        clip.identifiers.id,
        clip.identifiers.label,
        clip.source?.type,
        isActive ? "Active" : "Idle",
        clip.options?.auto_release ? "Auto-release" : undefined,
        clip.options?.deactivate_on_sequence_end
          ? "Deactivate on end"
          : undefined,
      ]),
    ),
  );

  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => displayRows().map(([clip]) => clip.identifiers.uid),
    selectedIds: selectedClipUids,
    onSelectionChange: setSelectedClipUids,
  });
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => displayRows().map(([clip]) => clip.identifiers.uid),
    selectedIds: selectedClipUids,
    onSelectionChange: setSelectedClipUids,
    multiSelectOnPlainClick: true,
  });

  /** Clears the current clip selection across list and grid modes. */
  const clearSelection = () => {
    setSelectedClipUids([]);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  /** Changes clip view mode and drops selections that would be hidden in the next mode. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode("clips-list", viewMode(), mode, setViewModeSignal, {
      onEnterGridMode: clearSelection,
      onEnterListMode: () => setSelectionModeEnabled(false),
    });
  };

  const crud = createClipCrudController({
    clips: $clips,
    allDisplayRows,
    selectedClipUids,
    setSelectedClipUids,
    selectedCount,
    viewMode,
    setSelectionModeEnabled,
  });

  /** Toggles one clip UID in the grid selection set. */
  const toggleSelection = (clipUid: string) => {
    setSelectedClipUids((current) => {
      const next = new Set(current);
      if (next.has(clipUid)) {
        next.delete(clipUid);
      } else {
        next.add(clipUid);
      }
      return Array.from(next);
    });
  };

  /** Toggles clip playback from a row with known active state. */
  const togglePlayback = (clipId: number, isActive: boolean) => {
    toggleClipPlayback(clipId, isActive);
  };

  /** Resolves a clip UID before toggling its current playback state. */
  const togglePlaybackByUid = (clipUid: string) => {
    const clipEntry = $clips()[clipUid];
    if (!clipEntry) return;
    togglePlayback(clipEntry[0].identifiers.id, clipEntry[1]);
  };

  /** Opens clip properties while keeping this panel's inspector provider active. */
  const openPropertiesForClip = (clipUid: string) => {
    setInspectedClipUid(clipUid);
    clipPropertiesInspector.activate();
    const api = $dockApi();
    if (!api) return;

    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    if (propertiesPanel) {
      const location = propertiesPanel.api.location;
      if (location.type === "edge") {
        propertiesPanel.api.setActive();
        api.getEdgeGroup(location.position)?.expand();
        requestAnimationFrame(() => api.getPanel(panelId)?.api.setActive());
      } else {
        propertiesPanel.focus();
      }
    } else {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
  };

  /** Selects and reveals a clip requested by another panel or palette. */
  useRevealObjectCapability(
    "panel-ClipList",
    (request) => {
      const row = allDisplayRows().find(
        ([clip]) => clip.identifiers.uid === request.uid,
      );
      if (!row) {
        return;
      }

      const selectClip = () => {
        setViewMode("list");
        setSelectedClipUids([request.uid]);
        crud.setListSelectionRequest({ row, requestId: request.requestId });
        if (request.intent === "properties") {
          openPropertiesForClip(request.uid);
        }
      };

      if (!displayRows().includes(row) && search.isFiltering()) {
        search.clear();
        setTimeout(selectClip, 0);
      } else {
        selectClip();
      }
    },
    {
      accepts: (payload) => payload.type === "clip",
    },
  );

  /** Routes card activation to selection or playback according to panel mode. */
  const handleClipClick = (clipUid: string) => {
    if (crud.isModalOpen()) return;
    if (selectionMode()) {
      toggleSelection(clipUid);
      return;
    }

    togglePlaybackByUid(clipUid);
  };

  /** Serializes a clip for assignment and timeline insertion drag targets. */
  const handleDragStart = (event: DragEvent, clip: types.Clip) => {
    if (selectionMode()) return;
    if (event.dataTransfer) {
      event.dataTransfer.setData("application/x-clip", JSON.stringify(clip));
      event.dataTransfer.setData(
        TIMELINE_INSERT_DRAG_MIME,
        serializeTimelineInsertDragPayload({
          source: "clip",
          actionType: "StartClip",
          targetUid: clip.identifiers.uid,
          targetLabel: `Exec ${clip.identifiers.id}: ${clip.identifiers.label}`,
        }),
      );
      event.dataTransfer.effectAllowed = "copy";
    }
  };

  /** Ensures a context-menu target participates in the current selection. */
  const selectForContextMenu = (clipUid: string) => {
    if (selectedUidSet().has(clipUid)) return;
    setSelectedClipUids([clipUid]);
  };

  /** Opens clip actions for the clicked row or card. */
  const openClipContextMenu = (clipUid: string, x: number, y: number) => {
    const clipEntry = $clips()[clipUid];
    if (!clipEntry) return;
    const [clip, isActive] = clipEntry;
    selectForContextMenu(clip.identifiers.uid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "toggle-clip",
          label: isActive ? "Stop Clip" : "Start Clip",
          icon: isActive ? StopIcon : PlayIcon,
          onSelect: () => togglePlaybackByUid(clipUid),
        },
        {
          id: "inspect-clip",
          label: "Show Properties",
          icon: GearSixIcon,
          onSelect: () => openPropertiesForClip(clip.identifiers.uid),
        },
        { id: "clip-action-separator", type: "separator" },
        {
          id: "new-clip",
          label: "New Clip",
          icon: PlusIcon,
          shortcut: "N",
          onSelect: crud.openCreate,
        },
        {
          id: "edit-clip",
          label: "Edit Clip",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          disabled: selectedCount() !== 1,
          onSelect: crud.openEditSelected,
        },
        {
          id: "rename-clip",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => crud.requestLabelEdit(clipEntry),
        },
        { id: "clip-menu-separator", type: "separator" },
        {
          id: "delete-clip",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Clips`
              : "Delete Clip",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: crud.openDeleteSelected,
        },
      ],
    });
  };

  /** Toggles grid selection mode unless another panel interaction owns focus. */
  const handleToggleSelectionMode = () => {
    if (crud.isModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /** Cancels the most specific active modal, search, or selection state. */
  const handleEscape = () => {
    if (crud.isDeleteModalOpen()) {
      crud.setIsDeleteModalOpen(false);
      return true;
    }
    if (crud.isEditModalOpen()) {
      crud.setIsEditModalOpen(false);
      return true;
    }
    if (crud.isCreateModalOpen()) {
      crud.setIsCreateModalOpen(false);
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
    handler: crud.openCreate,
    description: "Create clip",
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
    handler: crud.openEditSelected,
    description: "Open selected item",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: crud.openDeleteSelected,
    description: "Delete selected clips",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: crud.openDeleteSelected,
    description: "Delete selected clips",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Cancel or clear selection",
    componentId: panelId,
  });

  return (
    <div
      ref={panelRootRef}
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="clips"
      data-panel-id={panelId}
    >
      <ClipListToolbar
        search={search}
        viewMode={viewMode()}
        selectionMode={selectionMode()}
        selectedCount={selectedCount()}
        onCreate={crud.openCreate}
        onEditSelected={crud.openEditSelected}
        onDeleteSelected={crud.openDeleteSelected}
        onToggleSelectionMode={handleToggleSelectionMode}
        onViewModeChange={setViewMode}
      />

      <ClipEditorDialogs
        overwrite={crud.pendingOverwrite()}
        onCancelOverwrite={crud.cancelOverwrite}
        onOverwrite={crud.confirmOverwrite}
        createOpen={crud.isCreateModalOpen()}
        createInitialId={crud.createInitialId()}
        createInitialLabel={crud.createInitialLabel()}
        editOpen={crud.isEditModalOpen()}
        editInitialId={crud.editInitialId()}
        editInitialLabel={crud.editInitialLabel()}
        deleteOpen={crud.isDeleteModalOpen()}
        selectedCount={selectedCount()}
        onCancelCreate={() => crud.setIsCreateModalOpen(false)}
        onCancelEdit={() => crud.setIsEditModalOpen(false)}
        onCancelDelete={() => crud.setIsDeleteModalOpen(false)}
        onCreate={crud.submitCreate}
        onEdit={crud.submitEdit}
        onDelete={crud.confirmDeleteSelected}
      />

      <ClipListView
        panelId={panelId}
        viewMode={viewMode()}
        selectionMode={selectionMode()}
        rows={displayRows()}
        allRowCount={allDisplayRows().length}
        clipStates={$clips()}
        selectedUids={selectedUidSet()}
        editingCardLabelUid={crud.editingCardLabelUid()}
        editRequest={crud.labelEditRequest()}
        selectionRequest={crud.listSelectionRequest()}
        gridDragSelection={gridDragSelection}
        gridClickSelection={gridClickSelection}
        interactionBlocked={crud.isModalOpen()}
        onSelectionChange={setSelectedClipUids}
        onDeleteRequested={crud.openDeleteSelected}
        onTogglePlayback={togglePlayback}
        onClipClick={handleClipClick}
        onClipDragStart={handleDragStart}
        onOpenContextMenu={openClipContextMenu}
        onOpenProperties={openPropertiesForClip}
        onUpdateLabel={crud.updateLabel}
        onCancelCardLabelEdit={() => crud.setEditingCardLabelUid(null)}
      />

      <ClipControlsSection
        collapsed={controls.collapsed()}
        transitioning={controls.transitioning()}
        height={controls.height()}
        visibleHeight={controls.visibleHeight()}
        clipStates={$clips}
        onResizeStart={controls.handleResizeStart}
        onResizeKeyDown={controls.handleResizeKeyDown}
        onToggleCollapsed={controls.toggleCollapsed}
      />
    </div>
  );
}
