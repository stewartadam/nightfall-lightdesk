// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createMemo, createSignal } from "solid-js";
import {
  changeCrudPanelViewMode,
  loadCrudPanelViewMode,
} from "../../../../lib/crud-panel-view-mode";
import type {
  CrudListDataGridEditRequest,
  CrudListDataGridSelectionRequest,
} from "../crud-list-data-grid";
import {
  createCrudPanelSearch,
  createCrudPanelSearchQueryChangeEffect,
} from "../crud-panel-search";
import type { CrudViewMode } from "../crud-view-mode-toggle";
import { createCrudGridClickSelection } from "./crud-grid-click-selection";
import { createCrudGridDragSelection } from "./crud-grid-drag-selection";

export interface CrudListStateOptions {
  /** Dockview ID of the panel, which scopes the search shortcut. */
  panelId: string;
  /** Accessible label and placeholder of the toolbar search. */
  searchLabel: string;
  /** Storage key that remembers the panel's grid or list presentation. */
  viewModeKey: string;
  /**
   * UIDs of the rows currently shown, in display order. Read lazily, so it may refer to a memo
   * the controller defines after creating the state from its `search`.
   */
  orderedUids: Accessor<readonly string[]>;
  /**
   * Whether a panel-owned dialog other than the delete confirmation is open. While any dialog is
   * open, Escape and the selection mode toggle step aside.
   */
  otherDialogOpen?: Accessor<boolean>;
}

/**
 * Creates the state every CRUD list panel shares: toolbar search, grid or list presentation,
 * grid selection mode, the selected row UIDs, the row Properties shows, the delete confirmation,
 * inline label editing requests, the Escape chain, and grid click and drag selection.
 *
 * Feature controllers build their rows from `search`, pass their UIDs back through
 * `orderedUids`, and add the commands and dialogs specific to their objects.
 */
export function createCrudListState<T>(options: CrudListStateOptions) {
  const search = createCrudPanelSearch({
    componentId: options.panelId,
    label: options.searchLabel,
  });
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [viewMode, setViewModeSignal] = createSignal<CrudViewMode>(
    loadCrudPanelViewMode(options.viewModeKey),
  );
  const [selectedUids, setSelectedUids] = createSignal<string[]>([]);
  const [inspectedUid, setInspectedUid] = createSignal<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<T>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<T>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Number of selected rows. */
  const selectedCount = createMemo(() => selectedUids().length);
  /** Selected UIDs indexed for constant-time checks while rendering. */
  const selectedUidSet = createMemo(() => new Set(selectedUids()));

  /**
   * UID of the row Properties edits: the one selected row, nothing for several, or the row
   * last inspected from a card's settings button when nothing is selected.
   */
  const propertiesUid = createMemo(() => {
    if (selectedCount() === 1) return selectedUids()[0] ?? null;
    if (selectedCount() > 1) return null;
    return inspectedUid();
  });

  /** Replaces the selection with `uids`. */
  const select = (uids: string[]) => setSelectedUids(uids);

  /** Clears the selection. */
  const clearSelection = () => setSelectedUids([]);
  createCrudPanelSearchQueryChangeEffect(search, clearSelection);

  /** Whether a dialog owns the keyboard, so list shortcuts and clicks step aside. */
  const dialogOpen = () =>
    isDeleteModalOpen() || (options.otherDialogOpen?.() ?? false);

  /** Turns grid selection mode on or off, dropping the selection when it ends. */
  const setSelectionModeEnabled = (enabled: boolean) => {
    setSelectionMode(enabled);
    if (!enabled) clearSelection();
  };

  /** Persists and applies the grid or list presentation; list mode ends selection mode. */
  const setViewMode = (mode: CrudViewMode) => {
    changeCrudPanelViewMode(
      options.viewModeKey,
      viewMode(),
      mode,
      setViewModeSignal,
      {
        onEnterListMode: () => setSelectionModeEnabled(false),
      },
    );
  };

  /** Toggles grid selection mode; list mode always selects rows directly. */
  const handleToggleSelectionMode = () => {
    if (dialogOpen() || viewMode() === "list") return;
    setSelectionModeEnabled(!selectionMode());
  };

  /**
   * Clears the search, then the selection, then selection mode, one per Escape press. Returns
   * whether the press was consumed; an open dialog always consumes it.
   */
  const handleEscape = () => {
    if (dialogOpen()) return true;
    if (search.clear()) return true;
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

  /**
   * Starts inline label editing for `row`: on its card in grid presentation, or in the label
   * cell of the list grid.
   */
  const requestLabelEdit = (row: T, uid: string) => {
    if (viewMode() !== "list") {
      setEditingCardLabelUid(uid);
      return;
    }
    setLabelEditRequest({ row, columnId: "label", requestId: Date.now() });
  };

  /** Whether grid click and drag gestures select cards rather than act on them. */
  const gridSelectionEnabled = () => selectionMode() && viewMode() === "grid";
  const gridDragSelection = createCrudGridDragSelection({
    enabled: gridSelectionEnabled,
    orderedIds: options.orderedUids,
    selectedIds: selectedUids,
    onSelectionChange: select,
  });
  const gridClickSelection = createCrudGridClickSelection({
    enabled: gridSelectionEnabled,
    orderedIds: options.orderedUids,
    selectedIds: selectedUids,
    onSelectionChange: select,
    multiSelectOnPlainClick: true,
  });

  return {
    search,
    selectionMode,
    setSelectionModeEnabled,
    viewMode,
    setViewMode,
    selectedUids,
    setSelectedUids,
    selectedCount,
    selectedUidSet,
    select,
    clearSelection,
    inspectedUid,
    setInspectedUid,
    propertiesUid,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    dialogOpen,
    labelEditRequest,
    setLabelEditRequest,
    listSelectionRequest,
    setListSelectionRequest,
    editingCardLabelUid,
    setEditingCardLabelUid,
    requestLabelEdit,
    handleToggleSelectionMode,
    handleEscape,
    gridDragSelection,
    gridClickSelection,
  };
}

export type CrudListState<T> = ReturnType<typeof createCrudListState<T>>;
