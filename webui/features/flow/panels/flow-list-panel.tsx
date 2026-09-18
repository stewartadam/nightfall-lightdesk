// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal, For, Show } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import CrudInlineLabelEditor from "../../../components/widgets/crud/crud-inline-label-editor";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import CrudListDataGrid, {
  type CrudListDataGridEditRequest,
  type CrudListDataGridSelectionRequest,
} from "../../../components/widgets/crud/crud-list-data-grid";
import CrudPanelSearch, {
  createCrudPanelSearch,
  createCrudPanelSearchQueryChangeEffect,
} from "../../../components/widgets/crud/crud-panel-search";
import {
  CRUD_CARD_CLASS,
  CRUD_CARD_SELECTED_CLASS,
  CRUD_CARD_UNSELECTED_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudViewModeToggle, {
  type CrudViewMode,
  createCrudViewEntrance,
} from "../../../components/widgets/crud/crud-view-mode-toggle";
import { createCrudGridClickSelection } from "../../../components/widgets/crud/model/crud-grid-click-selection";
import { createCrudGridDragSelection } from "../../../components/widgets/crud/model/crud-grid-drag-selection";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  changeCrudPanelViewMode,
  loadCrudPanelViewMode,
} from "../../../lib/crud-panel-view-mode";
import {
  createDefaultFlow,
  deleteFlow,
  storeFlow,
} from "../../../lib/flow-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { dockApi, flows } from "../../../state/appStores";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";

interface FlowListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/**
 * Panel displaying a list of all flow entries.
 * Clicking a flow opens the Flow Editor panel for that flow.
 */
export default function FlowListPanel(props: FlowListPanelProps) {
  let viewContent: HTMLDivElement | undefined;
  createCrudViewEntrance(
    () => viewMode(),
    () => viewContent,
  );
  const $flows = useStore(flows);
  const $dockApi = useStore(dockApi);
  const panelId = props.initialPanelId ?? props.id;
  const search = createCrudPanelSearch({
    componentId: panelId,
    label: "Search flows",
  });
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode("flow-list"),
  );
  const [selectedFlowUids, setSelectedFlowUids] = createSignal<string[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<types.FlowDefinition>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<types.FlowDefinition>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  const selectedCount = createMemo(() => selectedFlowUids().length);
  const selectedFlowUidSet = createMemo(() => new Set(selectedFlowUids()));
  const propertiesFlow = createMemo(() => {
    if (selectedCount() !== 1) return null;
    const [flowUid] = selectedFlowUids();
    return flowUid ? ($flows()[flowUid] ?? null) : null;
  });

  usePropertiesInspector(
    panelId,
    "Flow",
    () => (
      <CrudLabelProperties
        entry={propertiesFlow()}
        entityName="Flow"
        getId={(flowEntry) => flowEntry.identifiers.id}
        getLabel={(flowEntry) => flowEntry.identifiers.label}
        onLabelCommit={(flowEntry, label) => updateFlowLabel(flowEntry, label)}
      />
    ),
    { priority: 10, autoActivate: true },
  );

  /** Stores a flow label change while preserving the flow graph. */
  const updateFlowLabel = (flowEntry: types.FlowDefinition, label: string) => {
    if (label === flowEntry.identifiers.label) return;
    storeFlow({
      ...flowEntry,
      identifiers: {
        ...flowEntry.identifiers,
        label,
      },
    });
  };

  /** Requests inline editing for the selected flow label cell. */
  const requestFlowLabelEdit = (flowEntry: types.FlowDefinition) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(flowEntry.identifiers.uid);
      return;
    }
    const startEdit = () =>
      setLabelEditRequest({
        row: flowEntry,
        columnId: "label",
        requestId: Date.now(),
      });
    startEdit();
  };

  const clearSelection = () => {
    setSelectedFlowUids([]);
  };
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) {
      clearSelection();
    }
  };

  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode("flow-list", viewMode(), mode, setViewModeSignal, {
      onEnterListMode: () => setSelectionModeEnabled(false),
    });
  };

  const toggleSelection = (flowUid: string) => {
    setSelectedFlowUids((current) => {
      const next = new Set(current);
      if (next.has(flowUid)) {
        next.delete(flowUid);
      } else {
        next.add(flowUid);
      }
      return Array.from(next);
    });
  };

  const openFlowEditor = (flowUid: string) => {
    const api = $dockApi();
    if (!api) return;

    const flowMap = $flows();
    const flowEntry = flowMap[flowUid];
    if (!flowEntry) return;

    const panelId = `flow-editor-${flowUid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      return panel.focus();
    }

    api.addPanel({
      id: panelId,
      component: "FlowEditor",
      title: `Flow ${flowEntry.identifiers.id}: ${flowEntry.identifiers.label}`,
      params: { initialFlowUid: flowUid },
      renderer: "onlyWhenVisible",
    });
  };

  const handleFlowItemClick = (flowUid: string) => {
    if (isDeleteModalOpen()) return;
    if (selectionMode()) {
      toggleSelection(flowUid);
      return;
    }

    openFlowEditor(flowUid);
  };

  const handleEditSelected = () => {
    if (isDeleteModalOpen()) return;
    const [selectedFlowUid] = selectedFlowUids();
    if (!selectedFlowUid) return;
    openFlowEditor(selectedFlowUid);
    setSelectionModeEnabled(false);
  };

  const handleDeleteSelected = () => {
    const selected = selectedFlowUids();
    if (selected.length === 0) return;
    setIsDeleteModalOpen(true);
  };

  const selectForContextMenu = (flowUid: string) => {
    if (selectedFlowUidSet().has(flowUid)) return;
    setSelectedFlowUids([flowUid]);
  };

  const openFlowContextMenu = (
    flowEntry: ReturnType<typeof flowList>[number],
    x: number,
    y: number,
  ) => {
    selectForContextMenu(flowEntry.identifiers.uid);
    openContextMenu({
      x,
      y,
      items: [
        {
          id: "open-flow",
          label: "Open Flow",
          icon: PencilSimpleLineIcon,
          shortcut: "Enter",
          onSelect: () => openFlowEditor(flowEntry.identifiers.uid),
        },
        {
          id: "rename-flow",
          label: "Rename",
          icon: PencilSimpleLineIcon,
          onSelect: () => requestFlowLabelEdit(flowEntry),
        },
        {
          id: "new-flow",
          label: "New Flow",
          icon: PlusIcon,
          onSelect: handleCreate,
        },
        { id: "flow-menu-separator", type: "separator" },
        {
          id: "delete-flow",
          label:
            selectedCount() > 1
              ? `Delete ${selectedCount()} Flows`
              : "Delete Flow",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: handleDeleteSelected,
        },
      ],
    });
  };

  const confirmDeleteSelected = () => {
    const selected = selectedFlowUids();
    if (selected.length === 0) {
      setIsDeleteModalOpen(false);
      return;
    }
    const flowMap = $flows();
    for (const flowUid of selected) {
      const flowEntry = flowMap[flowUid];
      if (!flowEntry) continue;
      deleteFlow(flowEntry.identifiers.id);
    }

    clearSelection();
    setIsDeleteModalOpen(false);
  };

  const handleToggleSelectionMode = () => {
    if (isDeleteModalOpen()) return;
    if (viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  const handleEscape = () => {
    if (isDeleteModalOpen()) return true;
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

  const handleCreate = () => {
    const flowMap = $flows();
    const existingIds = Object.values(flowMap).map(
      (flow) => flow.identifiers.id,
    );
    let newId = 1;
    while (existingIds.includes(newId)) {
      newId++;
    }

    const newFlow = createDefaultFlow(newId);
    storeFlow(newFlow);
    setTimeout(() => openFlowEditor(newFlow.identifiers.uid), 100);
  };

  /** Returns all flows in stable display order before toolbar filtering. */
  const allFlowList = createMemo(() => {
    const flowMap = $flows();
    return Object.values(flowMap).sort(
      (a, b) => a.identifiers.id - b.identifiers.id,
    );
  });

  /** Returns flows matching the live toolbar search query. */
  const flowList = createMemo(() =>
    allFlowList().filter((flowEntry) =>
      search.matches([
        flowEntry.identifiers.id,
        flowEntry.identifiers.label,
        flowEntry.nodes.length,
      ]),
    ),
  );

  /** Selects and reveals a flow requested by the showfile object palette. */
  useRevealObjectCapability(
    "panel-FlowList",
    (request) => {
      const flowEntry = $flows()[request.uid];
      if (!flowEntry) {
        return;
      }

      const selectEntry = () => {
        setViewMode("list");
        setSelectedFlowUids([request.uid]);
        setListSelectionRequest({
          row: flowEntry,
          requestId: request.requestId,
        });
      };

      if (!flowList().includes(flowEntry) && search.isFiltering()) {
        search.clear();
        setTimeout(selectEntry, 0);
      } else {
        selectEntry();
      }
    },
    {
      accepts: (payload) => payload.type === "flow",
    },
  );

  const gridDragSelection = createCrudGridDragSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => flowList().map((flowEntry) => flowEntry.identifiers.uid),
    selectedIds: selectedFlowUids,
    onSelectionChange: setSelectedFlowUids,
  });
  const gridClickSelection = createCrudGridClickSelection({
    enabled: () => selectionMode() && viewMode() === "grid",
    orderedIds: () => flowList().map((flowEntry) => flowEntry.identifiers.uid),
    selectedIds: selectedFlowUids,
    onSelectionChange: setSelectedFlowUids,
    multiSelectOnPlainClick: true,
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
    description: "Delete selected flows",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteSelected,
    description: "Delete selected flows",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: handleEscape,
    description: "Clear selection",
    componentId: panelId,
  });

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"Add flow"}
              type="button"
              onClick={handleCreate}
              label="Add flow"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <ToolbarButton
              tooltip={"Edit selected flow (Enter)"}
              type="button"
              onClick={handleEditSelected}
              disabled={selectedCount() !== 1}
              label="Edit selected flow"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <ToolbarButton
              variant="danger"
              size="labeled"
              tooltip={
                selectedCount() > 0
                  ? `Delete selected flows (${selectedCount()})`
                  : "Delete selected flows (Delete/Backspace)"
              }
              type="button"
              onClick={handleDeleteSelected}
              disabled={selectedCount() === 0}
              label="Delete selected flows"
            >
              <TrashIcon class="size-4" aria-hidden />
              <Show when={selectedCount() > 0}>
                <span class="rounded bg-red-800 px-1 text-[10px] leading-4 text-red-100">
                  {selectedCount()}
                </span>
              </Show>
            </ToolbarButton>

            <Show when={viewMode() === "grid"}>
              <div class="mx-1 h-6 w-px bg-neutral-700" aria-hidden="true" />

              <ToolbarButton
                tooltip={`${selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={handleToggleSelectionMode}
                ariaPressed={selectionMode()}
                label="Toggle selection mode"
              >
                <SelectionIcon class="size-4" aria-hidden />
              </ToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <CrudPanelSearch search={search} placeholder="Search flows" />
            <CrudViewModeToggle
              viewMode={viewMode()}
              onViewModeChange={setViewMode}
            />
          </>
        }
      />

      <DeleteConfirmModal
        isOpen={isDeleteModalOpen()}
        title="Delete selected flows"
        message={`Delete ${selectedCount()} selected flow(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={() => setIsDeleteModalOpen(false)}
        onConfirm={confirmDeleteSelected}
      />

      <div
        ref={viewContent}
        class="min-h-0 flex-1 overflow-auto"
        classList={{
          "p-4": viewMode() === "grid",
          relative: viewMode() === "grid",
          "select-none": selectionMode() && viewMode() === "grid",
        }}
        onPointerDown={gridDragSelection.onPointerDown}
        onPointerMove={gridDragSelection.onPointerMove}
        onPointerUp={gridDragSelection.onPointerUp}
        onPointerCancel={gridDragSelection.onPointerCancel}
        onClick={(event) => {
          if (gridDragSelection.consumeSuppressedClick()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          gridClickSelection.handleBackgroundClick(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") return;
        }}
      >
        <Show
          when={viewMode() === "grid"}
          fallback={
            <div class="h-full min-h-0">
              <CrudListDataGrid
                panelId={panelId}
                rows={flowList()}
                rowKey={(flowEntry) => flowEntry.identifiers.uid}
                editRequest={labelEditRequest()}
                selectionRequest={listSelectionRequest()}
                columns={[
                  {
                    id: "id",
                    title: "ID",
                    width: 70,
                    value: (flowEntry) => flowEntry.identifiers.id,
                  },
                  {
                    id: "label",
                    title: "Label",
                    width: 260,
                    value: (flowEntry) => flowEntry.identifiers.label,
                    onEdit: updateFlowLabel,
                  },
                  {
                    id: "nodes",
                    title: "Nodes",
                    width: 90,
                    value: (flowEntry) => flowEntry.nodes.length,
                  },
                ]}
                isRowSelected={(flowEntry) =>
                  selectedFlowUidSet().has(flowEntry.identifiers.uid)
                }
                onSelectionChange={(rows) =>
                  setSelectedFlowUids(
                    rows.map((flowEntry) => flowEntry.identifiers.uid),
                  )
                }
                onDeleteRequested={handleDeleteSelected}
                multiSelectOnPlainClick={selectionMode()}
                onRowClick={(flowEntry, modifiers) => {
                  if (isDeleteModalOpen() || !modifiers.altKey) return;
                  openFlowEditor(flowEntry.identifiers.uid);
                }}
                onRowContextMenu={(flowEntry, _modifiers, position) => {
                  if (isDeleteModalOpen()) return;
                  openFlowContextMenu(flowEntry, position.x, position.y);
                }}
              />
            </div>
          }
        >
          <Show
            when={flowList().length > 0}
            fallback={
              <div class="text-neutral-500 text-center py-8">
                <Show
                  when={allFlowList().length > 0}
                  fallback={
                    <>
                      <p>No flows defined</p>
                      <p class="text-sm mt-2">
                        Use the add button in the toolbar to create your first
                        flow
                      </p>
                    </>
                  }
                >
                  <p>No matching flows</p>
                </Show>
              </div>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              <For each={flowList()}>
                {(flowEntry) => {
                  const isSelected = () =>
                    selectedFlowUidSet().has(flowEntry.identifiers.uid);
                  return (
                    <button
                      type="button"
                      data-crud-select-id={flowEntry.identifiers.uid}
                      onClick={(event) => {
                        if (gridDragSelection.consumeSuppressedClick()) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        if (
                          gridClickSelection.handleCardClick(
                            flowEntry.identifiers.uid,
                            event,
                          )
                        ) {
                          return;
                        }
                        handleFlowItemClick(flowEntry.identifiers.uid);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openFlowContextMenu(
                          flowEntry,
                          event.clientX,
                          event.clientY,
                        );
                      }}
                      class={CRUD_CARD_CLASS}
                      classList={{
                        [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
                        [CRUD_CARD_SELECTED_CLASS]: isSelected(),
                      }}
                    >
                      <div class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
                        <span>{flowEntry.identifiers.id}:</span>
                        <CrudInlineLabelEditor
                          ariaLabel="Flow card label"
                          class="truncate"
                          editing={
                            editingCardLabelUid() === flowEntry.identifiers.uid
                          }
                          label={flowEntry.identifiers.label}
                          onCancel={() => setEditingCardLabelUid(null)}
                          onCommit={(label) =>
                            updateFlowLabel(flowEntry, label)
                          }
                        >
                          {flowEntry.identifiers.label}
                        </CrudInlineLabelEditor>
                      </div>
                      <div class="text-xs text-neutral-400 mt-1">
                        {flowEntry.nodes.length} node
                        {flowEntry.nodes.length !== 1 ? "s" : ""}
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
        <Show when={viewMode() === "grid" && gridDragSelection.dragBox()}>
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
