// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { PencilSimpleLineIcon } from "@squidlab/phosphor-solid/pencil-simple-line";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Show } from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import { InlineRenameField } from "../../../components/ui/inline-rename-field";
import PanelToolbar, {
  ToolbarSeparator,
} from "../../../components/ui/panel-toolbar";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import { Button } from "../../../components/ui/visual-language/button";
import CrudListDataGrid from "../../../components/widgets/crud/crud-list-data-grid";
import CrudPanelSearch from "../../../components/widgets/crud/crud-panel-search";
import {
  CRUD_CARD_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import { CrudRunStopButtons } from "../../../components/widgets/crud/crud-run-stop-buttons";
import CrudScrollArea from "../../../components/widgets/crud/crud-scroll-area";
import CrudViewModeToggle from "../../../components/widgets/crud/crud-view-mode-toggle";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../../../components/widgets/entity-editor-dialog";
import { setObjectDragData } from "../../../lib/object-drag";
import { type Macro, ObjectType } from "../../../types";
import type { MacroListController } from "../controllers/macro-list-controller";
import {
  firstCommandLine,
  macroDisplayName,
  macroRunLabel,
  macroRunStatus,
} from "../model/macro-model";

interface MacroListViewProps {
  controller: MacroListController;
}

/** Describes a macro's state for cards and rows: its run progress, or "Idle". */
function runStateLabel(controller: MacroListController, macro: Macro): string {
  const run = macroRunStatus(controller.macroRuns(), macro);
  return run ? macroRunLabel(run) : "Idle";
}

/** Renders one macro card. Clicking it runs the macro, or stops it while it runs. */
function MacroCard(props: MacroListViewProps & { macro: Macro }) {
  const controller = props.controller;
  /** UID of this card's macro, as keyed in the selection. */
  const uid = () => props.macro.identifiers.uid;
  /** Whether this card's macro is selected, in or out of selection mode. */
  const isSelected = () => controller.selectedMacroUidSet().has(uid());
  /** Whether any body of this card's macro is running. */
  const running = () => controller.isRunning(props.macro);

  return (
    <div
      role="button"
      tabIndex={controller.selectionMode() ? -1 : 0}
      aria-label={`Macro ${props.macro.identifiers.id}: ${macroDisplayName(props.macro)}, ${runStateLabel(controller, props.macro)}`}
      data-crud-select-id={uid()}
      data-macro-card={props.macro.identifiers.id}
      data-running={running() ? "" : undefined}
      draggable={!controller.selectionMode()}
      onDragStart={(event) => {
        if (!event.dataTransfer) return;
        setObjectDragData(event.dataTransfer, ObjectType.Macro, uid());
        event.dataTransfer.setData("text/plain", macroDisplayName(props.macro));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={(event) => controller.handleMacroClick(props.macro, event)}
      onKeyDown={(event) => {
        if (controller.selectionMode()) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        controller.toggleRun(props.macro);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        controller.openMacroContextMenu(
          props.macro,
          event.clientX,
          event.clientY,
        );
      }}
      class={CRUD_CARD_CLASS}
      classList={{ "ring-1 ring-emerald-400/70": running() }}
      data-selectable-surface
      data-selected={isSelected()}
      aria-pressed={isSelected()}
    >
      <div class="flex items-start justify-between gap-2">
        <div
          class="nf-crud-card-title flex min-w-0 items-center gap-1"
          title={props.macro.identifiers.label}
        >
          <span class="shrink-0 whitespace-nowrap">
            {props.macro.identifiers.id}:
          </span>
          <Show
            when={controller.editingCardLabelUid() === uid()}
            fallback={
              <span class="min-w-0 truncate">
                {macroDisplayName(props.macro)}
              </span>
            }
          >
            <InlineRenameField
              ariaLabel="Macro card label"
              allowEmpty
              value={props.macro.identifiers.label}
              onClose={() => controller.setEditingCardLabelUid(null)}
              onCommit={(label) =>
                controller.updateMacroLabel(props.macro, label)
              }
            />
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Show when={running()}>
            <PlayIcon class="size-3.5 text-emerald-300" aria-hidden />
          </Show>
          <Button
            variant="subtle"
            size="icon-inline"
            aria-label={`Inspect macro ${props.macro.identifiers.id}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              controller.inspectMacro(props.macro);
            }}
          >
            <GearSixIcon class="size-3" aria-hidden />
          </Button>
        </div>
      </div>
      <div
        class="nf-crud-card-meta truncate"
        classList={{ "text-emerald-300": running() }}
        data-macro-run-state=""
      >
        {runStateLabel(controller, props.macro)}
      </div>
    </div>
  );
}

/** Renders macros in the editable row grid; Alt+click or Enter runs a macro. */
function MacroRowList(props: MacroListViewProps) {
  const controller = props.controller;
  return (
    <div class="h-full min-h-0">
      <CrudListDataGrid
        panelId={controller.panelId}
        rows={controller.macroList()}
        rowKey={(macro) => macro.identifiers.uid}
        editRequest={controller.labelEditRequest()}
        selectionRequest={controller.listSelectionRequest()}
        columns={[
          {
            id: "id",
            title: "ID",
            width: 70,
            value: (macro) => macro.identifiers.id,
            filter: { kind: "number" },
          },
          {
            id: "label",
            title: "Label",
            width: 200,
            minWidth: 140,
            value: (macro) => macro.identifiers.label,
            onEdit: controller.updateMacroLabel,
          },
          {
            id: "commands",
            title: "First command",
            width: 240,
            value: (macro) => firstCommandLine(macro.commands),
          },
          {
            id: "state",
            title: "State",
            width: 200,
            value: (macro) => runStateLabel(controller, macro),
          },
        ]}
        isRowSelected={(macro) =>
          controller.selectedMacroUidSet().has(macro.identifiers.uid)
        }
        onSelectionChange={(rows) =>
          controller.selectMacros(rows.map((macro) => macro.identifiers.uid))
        }
        onDeleteRequested={controller.handleDeleteSelected}
        multiSelectOnPlainClick={controller.selectionMode()}
        onRowClick={(macro, modifiers) => {
          if (controller.dialogOpen() || !modifiers.altKey) return;
          controller.toggleRun(macro);
        }}
        onRowContextMenu={(macro, _modifiers, position) => {
          if (controller.dialogOpen()) return;
          controller.openMacroContextMenu(macro, position.x, position.y);
        }}
      />
    </div>
  );
}

/** Presents the Macros panel: the standard toolbar, dialogs, and grid or list of macros. */
export function MacroListView(props: MacroListViewProps) {
  const controller = props.controller;
  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-panel-kind="macro-list"
      data-panel-id={controller.panelId}
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip="Add macro (N)"
              type="button"
              onClick={controller.handleCreate}
              label="Add macro"
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip="Edit selected macro (E)"
              type="button"
              onClick={controller.handleEditSelected}
              disabled={controller.selectedCount() !== 1}
              label="Edit selected macro"
            >
              <PencilSimpleLineIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              count={controller.selectedCount()}
              tooltip={
                controller.selectedCount() > 0
                  ? `Delete selected macros (${controller.selectedCount()})`
                  : "Delete selected macros (Delete/Backspace)"
              }
              type="button"
              onClick={controller.handleDeleteSelected}
              disabled={controller.selectedCount() === 0}
              label="Delete selected macros"
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <CrudRunStopButtons
              noun="macros"
              canRun={controller.canRunSelected()}
              canStop={controller.canStopSelected()}
              onRun={controller.handleRunSelected}
              onStop={controller.handleStopSelected}
            />
            <Show when={controller.viewMode() === "grid"}>
              <ToolbarSeparator />
              <ToggleToolbarButton
                tooltip={`${controller.selectionMode() ? "Exit" : "Enter"} selection mode (V)`}
                type="button"
                onClick={controller.handleToggleSelectionMode}
                pressed={controller.selectionMode()}
                label="Toggle selection mode"
              >
                <SelectionIcon class="size-4" aria-hidden />
              </ToggleToolbarButton>
            </Show>
          </>
        }
        right={
          <>
            <CrudPanelSearch
              search={controller.search}
              placeholder="Search macros"
            />
            <CrudViewModeToggle
              viewMode={controller.viewMode()}
              onViewModeChange={controller.setViewMode}
            />
          </>
        }
      />

      <EntityEditorModal
        isOpen={controller.isEditModalOpen()}
        title="Edit macro"
        submitLabel="Save"
        initialId={controller.editingMacro()?.identifiers.id ?? 1}
        initialLabel={controller.editingMacro()?.identifiers.label ?? ""}
        idLabel="Macro ID"
        labelLabel="Macro label"
        onCancel={controller.closeEditor}
        onSubmit={controller.handleEditSubmit}
      />
      <DeleteConfirmModal
        isOpen={controller.isDeleteModalOpen()}
        title="Delete selected macros"
        message={`Delete ${controller.selectedCount()} selected macro(s)? Running macros stop.`}
        confirmLabel="Delete"
        onCancel={() => controller.setIsDeleteModalOpen(false)}
        onConfirm={controller.confirmDeleteSelected}
      />

      <CrudScrollArea
        viewMode={controller.viewMode()}
        aria-label="Macros scroll area"
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
            // Background clicks only clear selection; keyboard users use Escape (a panel shortcut).
            if (event.key === "Escape") return;
          }}
        >
          <Show
            when={controller.macroList().length > 0}
            fallback={
              <Show
                when={controller.allMacroList().length > 0}
                fallback={
                  <EmptyState
                    title="No macros yet"
                    description="Add one with the + button, then type its commands in Properties"
                  />
                }
              >
                <EmptyState title="No matching macros" />
              </Show>
            }
          >
            <Show
              when={controller.viewMode() === "grid"}
              fallback={<MacroRowList controller={controller} />}
            >
              <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                <For each={controller.macroList()}>
                  {(macro) => (
                    <MacroCard controller={controller} macro={macro} />
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
