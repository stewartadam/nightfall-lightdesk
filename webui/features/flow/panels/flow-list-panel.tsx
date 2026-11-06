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
import { createMemo, For, Show } from "solid-js";
import { openContextMenu } from "../../../components/providers/context-menu";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import { EmptyState } from "../../../components/ui/empty-state";
import { InlineRenameField } from "../../../components/ui/inline-rename-field";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import CrudListDataGrid from "../../../components/widgets/crud/crud-list-data-grid";
import CrudPanelSearch from "../../../components/widgets/crud/crud-panel-search";
import {
  CRUD_CARD_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudViewModeToggle, {
  createCrudViewEntrance,
} from "../../../components/widgets/crud/crud-view-mode-toggle";
import { createCrudListState } from "../../../components/widgets/crud/model/crud-list-state";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  createDefaultFlow,
  deleteFlow,
  storeFlow,
} from "../../../lib/flow-service";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { focusExistingPanel } from "../../../lib/panel-open-command";
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
  const $flows = useStore(flows);
  const $dockApi = useStore(dockApi);
  const panelId = props.initialPanelId ?? props.id;
  const crud = createCrudListState<types.FlowDefinition>({
    panelId,
    searchLabel: "Search flows",
    viewModeKey: "flow-list",
    orderedUids: (): readonly string[] => flowUids(),
  });
  const { search } = crud;
  createCrudViewEntrance(crud.viewMode, () => viewContent);

  /** Resolves the sole selected flow that Properties edits, if it still exists. */
  const propertiesFlow = createMemo(() => {
    const flowUid = crud.propertiesUid();
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
  const requestFlowLabelEdit = (flowEntry: types.FlowDefinition) =>
    crud.requestLabelEdit(flowEntry.identifiers.uid, () => flowEntry);

  /** Focuses the Flow Editor already showing `flowUid`, or opens a new one for it. */
  const openFlowEditor = (flowUid: string) => {
    const api = $dockApi();
    if (!api) return;

    const flowMap = $flows();
    const flowEntry = flowMap[flowUid];
    if (!flowEntry) return;

    const panelId = `flow-editor-${flowUid}`;
    if (focusExistingPanel(api, panelId)) return;

    api.addPanel({
      id: panelId,
      component: "FlowEditor",
      title: `Flow ${flowEntry.identifiers.id}: ${flowEntry.identifiers.label}`,
      params: { initialFlowUid: flowUid },
      renderer: "onlyWhenVisible",
    });
  };

  /** Opens a card's flow once grid selection has declined the click. */
  const handleFlowItemClick = (flowUid: string) => {
    if (crud.dialogOpen()) return;
    openFlowEditor(flowUid);
  };

  /** Opens the first selected flow in the Flow Editor and leaves selection mode. */
  const handleEditSelected = () => {
    if (crud.dialogOpen()) return;
    const [selectedFlowUid] = crud.selectedUids();
    if (!selectedFlowUid) return;
    openFlowEditor(selectedFlowUid);
    crud.setSelectionModeEnabled(false);
  };

  /** Opens the row actions for `flowEntry`, selecting it first unless it is already selected. */
  const openFlowContextMenu = (
    flowEntry: ReturnType<typeof flowList>[number],
    x: number,
    y: number,
  ) => {
    crud.selectForContextMenu(flowEntry.identifiers.uid);
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
            crud.selectedCount() > 1
              ? `Delete ${crud.selectedCount()} Flows`
              : "Delete Flow",
          icon: TrashIcon,
          shortcut: "Delete",
          danger: true,
          onSelect: crud.requestDelete,
        },
      ],
    });
  };

  /** Deletes every selected flow after confirmation. */
  const confirmDeleteSelected = () =>
    crud.confirmDelete((flowUid) => {
      const flowEntry = $flows()[flowUid];
      if (flowEntry) deleteFlow(flowEntry.identifiers.id);
    });

  /** Stores a new default flow under the first free ID, then opens it in the Flow Editor. */
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

      /** Switches to list mode and selects the requested flow row. */
      const selectEntry = () =>
        crud.revealRow(flowEntry, request.uid, request.requestId);

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

  /** UIDs of the flows currently shown, in display order, for range selection. */
  const flowUids = createMemo(() =>
    flowList().map((flowEntry) => flowEntry.identifiers.uid),
  );

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
    description: "Delete selected flows",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: crud.requestDelete,
    description: "Delete selected flows",
    componentId: panelId,
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: crud.handleEscape,
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
              disabled={crud.selectedCount() !== 1}
              label="Edit selected flow"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <ToolbarButton
              variant="danger"
              count={crud.selectedCount()}
              tooltip={
                crud.selectedCount() > 0
                  ? `Delete selected flows (${crud.selectedCount()})`
                  : "Delete selected flows (Delete/Backspace)"
              }
              type="button"
              onClick={crud.requestDelete}
              disabled={crud.selectedCount() === 0}
              label="Delete selected flows"
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>

            <Show when={crud.viewMode() === "grid"}>
              <ToolbarSeparator />

              <ToggleToolbarButton
                tooltip={`${crud.selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={crud.handleToggleSelectionMode}
                pressed={crud.selectionMode()}
                label="Toggle selection mode"
              >
                <SelectionIcon class="size-4" aria-hidden />
              </ToggleToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <CrudPanelSearch search={search} placeholder="Search flows" />
            <CrudViewModeToggle
              viewMode={crud.viewMode()}
              onViewModeChange={crud.setViewMode}
            />
          </>
        }
      />

      <DeleteConfirmModal
        isOpen={crud.isDeleteModalOpen()}
        title="Delete selected flows"
        message={`Delete ${crud.selectedCount()} selected flow(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={crud.closeDeleteConfirm}
        onConfirm={confirmDeleteSelected}
      />

      <div
        ref={viewContent}
        class="min-h-0 flex-1 overflow-auto"
        classList={{
          "p-4": crud.viewMode() === "grid",
          relative: crud.viewMode() === "grid",
          "select-none": crud.selectionMode() && crud.viewMode() === "grid",
        }}
        onPointerDown={crud.gridDragSelection.onPointerDown}
        onPointerMove={crud.gridDragSelection.onPointerMove}
        onPointerUp={crud.gridDragSelection.onPointerUp}
        onPointerCancel={crud.gridDragSelection.onPointerCancel}
        onClick={(event) => {
          if (crud.gridDragSelection.consumeSuppressedClick()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          crud.gridClickSelection.handleBackgroundClick(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") return;
        }}
      >
        <Show
          when={crud.viewMode() === "grid"}
          fallback={
            <div class="h-full min-h-0">
              <CrudListDataGrid
                panelId={panelId}
                rows={flowList()}
                rowKey={(flowEntry) => flowEntry.identifiers.uid}
                editRequest={crud.labelEditRequest()}
                selectionRequest={crud.listSelectionRequest()}
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
                  crud.selectedUidSet().has(flowEntry.identifiers.uid)
                }
                onSelectionChange={(rows) =>
                  crud.select(
                    rows.map((flowEntry) => flowEntry.identifiers.uid),
                  )
                }
                onDeleteRequested={crud.requestDelete}
                multiSelectOnPlainClick={crud.selectionMode()}
                onRowClick={(flowEntry, modifiers) => {
                  if (crud.isDeleteModalOpen() || !modifiers.altKey) return;
                  openFlowEditor(flowEntry.identifiers.uid);
                }}
                onRowContextMenu={(flowEntry, _modifiers, position) => {
                  if (crud.isDeleteModalOpen()) return;
                  openFlowContextMenu(flowEntry, position.x, position.y);
                }}
              />
            </div>
          }
        >
          <Show
            when={flowList().length > 0}
            fallback={
              <Show
                when={allFlowList().length > 0}
                fallback={
                  <EmptyState
                    title="No flows defined"
                    description="Use the add button in the toolbar to create your first flow"
                  />
                }
              >
                <EmptyState title="No matching flows" />
              </Show>
            }
          >
            <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              <For each={flowList()}>
                {(flowEntry) => {
                  const isSelected = () =>
                    crud.selectedUidSet().has(flowEntry.identifiers.uid);
                  return (
                    <button
                      type="button"
                      data-crud-select-id={flowEntry.identifiers.uid}
                      onClick={(event) => {
                        if (crud.gridDragSelection.consumeSuppressedClick()) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        if (
                          crud.gridClickSelection.handleCardClick(
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
                      data-selectable-surface
                      data-selected={isSelected()}
                    >
                      <div class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
                        <span>{flowEntry.identifiers.id}:</span>
                        <Show
                          when={
                            crud.editingCardLabelUid() ===
                            flowEntry.identifiers.uid
                          }
                          fallback={
                            <span class="truncate">
                              {flowEntry.identifiers.label}
                            </span>
                          }
                        >
                          <InlineRenameField
                            ariaLabel="Flow card label"
                            allowEmpty
                            value={flowEntry.identifiers.label}
                            onClose={crud.finishCardLabelEdit}
                            onCommit={(label) =>
                              updateFlowLabel(flowEntry, label)
                            }
                          />
                        </Show>
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
        <Show
          when={crud.viewMode() === "grid" && crud.gridDragSelection.dragBox()}
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
