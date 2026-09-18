// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { GearSixIcon } from "@squidlab/phosphor-solid/gear-six";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { For, Show } from "solid-js";
import CrudInlineLabelEditor from "../../../components/widgets/crud/crud-inline-label-editor";
import CrudListDataGrid, {
  type CrudListDataGridEditRequest,
  type CrudListDataGridSelectionRequest,
} from "../../../components/widgets/crud/crud-list-data-grid";
import {
  CRUD_CARD_CLASS,
  CRUD_CARD_SELECTED_CLASS,
  CRUD_CARD_UNSELECTED_CLASS,
  CRUD_GRID_DRAG_BOX_CLASS,
} from "../../../components/widgets/crud/crud-panel-styles";
import CrudScrollArea from "../../../components/widgets/crud/crud-scroll-area";
import type { CrudViewMode } from "../../../components/widgets/crud/crud-view-mode-toggle";
import type { createCrudGridClickSelection } from "../../../components/widgets/crud/model/crud-grid-click-selection";
import type { createCrudGridDragSelection } from "../../../components/widgets/crud/model/crud-grid-drag-selection";
import type { ClipMap } from "../../../state/appStores";
import type * as types from "../../../types";

type ClipEntry = [types.Clip, boolean];

interface ClipListViewProps {
  panelId: string;
  viewMode: CrudViewMode;
  selectionMode: boolean;
  rows: ClipEntry[];
  allRowCount: number;
  clipStates: ClipMap;
  selectedUids: Set<string>;
  editingCardLabelUid: string | null;
  editRequest: CrudListDataGridEditRequest<ClipEntry> | undefined;
  selectionRequest: CrudListDataGridSelectionRequest<ClipEntry> | undefined;
  gridDragSelection: ReturnType<typeof createCrudGridDragSelection>;
  gridClickSelection: ReturnType<typeof createCrudGridClickSelection>;
  interactionBlocked: boolean;
  onSelectionChange: (uids: string[]) => void;
  onDeleteRequested: () => void;
  onTogglePlayback: (clipId: number, isActive: boolean) => void;
  onClipClick: (clipUid: string) => void;
  onClipDragStart: (event: DragEvent, clip: types.Clip) => void;
  onOpenContextMenu: (clipUid: string, x: number, y: number) => void;
  onOpenProperties: (clipUid: string) => void;
  onUpdateLabel: (entry: ClipEntry, label: string) => void;
  onCancelCardLabelEdit: () => void;
}

/** Renders clip list and card presentations from controller-owned state. */
export function ClipListView(props: ClipListViewProps) {
  return (
    <CrudScrollArea
      viewMode={props.viewMode}
      aria-label="Clips scroll area"
      classList={{
        "p-4": props.viewMode === "grid",
        relative: props.viewMode === "grid",
        "select-none": props.selectionMode && props.viewMode === "grid",
      }}
      onPointerDown={props.gridDragSelection.onPointerDown}
      onPointerMove={props.gridDragSelection.onPointerMove}
      onPointerUp={props.gridDragSelection.onPointerUp}
      onPointerCancel={props.gridDragSelection.onPointerCancel}
      onClick={(event) => {
        if (props.gridDragSelection.consumeSuppressedClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        props.gridClickSelection.handleBackgroundClick(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") return;
      }}
    >
      <Show
        when={props.viewMode === "grid"}
        fallback={
          <div class="h-full min-h-0">
            <CrudListDataGrid
              panelId={props.panelId}
              rows={props.rows}
              rowKey={([clip]) => clip.identifiers.uid}
              editRequest={props.editRequest}
              selectionRequest={props.selectionRequest}
              columns={[
                {
                  id: "id",
                  title: "ID",
                  width: 70,
                  value: ([clip]) => clip.identifiers.id,
                  filter: { kind: "number" },
                },
                {
                  id: "label",
                  title: "Label",
                  width: 240,
                  value: ([clip]) => clip.identifiers.label,
                  onEdit: props.onUpdateLabel,
                },
                {
                  id: "source",
                  title: "Source",
                  width: 120,
                  value: ([clip]) => clip.source?.type ?? "None",
                },
                {
                  id: "auto_release",
                  title: "Options",
                  width: 180,
                  value: ([clip]) =>
                    [
                      clip.options?.auto_release ? "Auto-release" : "",
                      clip.options?.deactivate_on_sequence_end
                        ? "Deactivate on end"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(", "),
                },
                {
                  id: "state",
                  title: "State",
                  width: 100,
                  value: ([, isActive]) => (isActive ? "Active" : "Idle"),
                  filter: {
                    kind: "enum",
                    options: [
                      { value: "Active", label: "Active" },
                      { value: "Idle", label: "Idle" },
                    ],
                  },
                },
              ]}
              isRowSelected={([clip]) =>
                props.selectedUids.has(clip.identifiers.uid)
              }
              onSelectionChange={(rows) =>
                props.onSelectionChange(
                  rows.map(([clip]) => clip.identifiers.uid),
                )
              }
              onDeleteRequested={props.onDeleteRequested}
              rowSelectionOnly
              multiSelectOnPlainClick={props.selectionMode}
              onRowClick={([clip, isActive], modifiers) => {
                if (props.interactionBlocked) return;
                if (modifiers.altKey) {
                  props.onTogglePlayback(clip.identifiers.id, isActive);
                }
              }}
              onRowContextMenu={(entry, _modifiers, position) => {
                if (props.interactionBlocked) return;
                props.onOpenContextMenu(
                  entry[0].identifiers.uid,
                  position.x,
                  position.y,
                );
              }}
            />
          </div>
        }
      >
        <Show
          when={props.rows.length > 0}
          fallback={
            <div class="py-8 text-center text-neutral-500">
              <Show
                when={props.allRowCount > 0}
                fallback={
                  <>
                    <p>No clips defined</p>
                    <p class="mt-2 text-sm">
                      Use the add button in the toolbar to create a clip
                    </p>
                  </>
                }
              >
                <p>No matching clips</p>
              </Show>
            </div>
          }
        >
          <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
            <For each={props.rows.map(([clip]) => clip.identifiers.uid)}>
              {(uid) => {
                /** Returns the latest clip entry for this reactive card. */
                const clipEntry = () => props.clipStates[uid];
                /** Returns the current clip snapshot for this card. */
                const clip = () => clipEntry()?.[0];
                /** Returns whether this card's clip is currently active. */
                const isActive = () => clipEntry()?.[1] ?? false;
                /** Returns whether this card participates in panel selection. */
                const isSelected = () => props.selectedUids.has(uid);

                return (
                  <div
                    data-crud-select-id={uid}
                    onClick={(event) => {
                      if (props.gridDragSelection.consumeSuppressedClick()) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      if (
                        props.gridClickSelection.handleCardClick(uid, event)
                      ) {
                        return;
                      }
                      props.onClipClick(uid);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onOpenContextMenu(
                        uid,
                        event.clientX,
                        event.clientY,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (props.selectionMode) return;
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      props.onClipClick(uid);
                    }}
                    draggable={!props.selectionMode}
                    onDragStart={(event) => {
                      const currentClip = clip();
                      if (currentClip) {
                        props.onClipDragStart(event, currentClip);
                      }
                    }}
                    role="button"
                    tabIndex={props.selectionMode ? -1 : 0}
                    class={CRUD_CARD_CLASS}
                    classList={{
                      [CRUD_CARD_UNSELECTED_CLASS]: !isSelected(),
                      [CRUD_CARD_SELECTED_CLASS]: isSelected(),
                    }}
                  >
                    <div class="flex items-start justify-between gap-2">
                      <div class="flex min-w-0 items-center gap-1 font-medium text-neutral-200">
                        <span class="shrink-0 whitespace-nowrap">
                          {clip()?.identifiers.id}:
                        </span>
                        <Show when={clip()}>
                          {(currentClip) => (
                            <CrudInlineLabelEditor
                              ariaLabel="Clip card label"
                              class="truncate"
                              editing={props.editingCardLabelUid === uid}
                              label={currentClip().identifiers.label}
                              onCancel={props.onCancelCardLabelEdit}
                              onCommit={(label) =>
                                props.onUpdateLabel(
                                  [currentClip(), isActive()],
                                  label,
                                )
                              }
                            >
                              {currentClip().identifiers.label}
                            </CrudInlineLabelEditor>
                          )}
                        </Show>
                      </div>
                      <div class="flex shrink-0 items-center gap-1">
                        <Show when={isActive()}>
                          <span
                            data-clip-active-indicator={uid}
                            aria-hidden="true"
                          >
                            <PlayIcon
                              class="size-3.5 text-emerald-300"
                              aria-hidden
                            />
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100"
                          aria-label={`Inspect clip ${clip()?.identifiers.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onOpenProperties(uid);
                          }}
                        >
                          <GearSixIcon class="size-4" aria-hidden />
                        </button>
                      </div>
                    </div>
                    <div class="nf-tile-badges uppercase">
                      <span class="nf-tile-badge rounded bg-neutral-800 text-neutral-300">
                        {clip()?.source?.type ?? "None"}
                      </span>
                      <Show when={clip()?.options?.auto_release}>
                        <span class="nf-tile-badge rounded bg-blue-500/20 text-blue-100">
                          AR
                        </span>
                      </Show>
                      <Show when={clip()?.options?.deactivate_on_sequence_end}>
                        <span class="nf-tile-badge rounded bg-amber-500/20 text-amber-100">
                          END
                        </span>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show
        when={props.viewMode === "grid" && props.gridDragSelection.dragBox()}
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
  );
}
