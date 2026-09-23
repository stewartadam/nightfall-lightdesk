// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, type Setter } from "solid-js";
import type {
  CrudListDataGridEditRequest,
  CrudListDataGridSelectionRequest,
} from "../../../components/widgets/crud/crud-list-data-grid";
import type { CrudViewMode } from "../../../components/widgets/crud/crud-view-mode-toggle";
import type { ClipMap } from "../../../state/appStores";
import type * as types from "../../../types";
import { deleteClip, renameClip, storeClip } from "../services/clip-commands";

export type ClipEntry = [types.Clip, boolean];

interface ClipCrudControllerOptions {
  clips: Accessor<ClipMap>;
  allDisplayRows: Accessor<ClipEntry[]>;
  selectedClipUids: Accessor<string[]>;
  setSelectedClipUids: Setter<string[]>;
  selectedCount: Accessor<number>;
  viewMode: Accessor<CrudViewMode>;
  setSelectionModeEnabled: (enabled: boolean) => void;
}

/** Owns clip create, edit, inline-label, and delete interaction state. */
export function createClipCrudController(options: ClipCrudControllerOptions) {
  const [isDeleteModalOpen, setIsDeleteModalOpen] = createSignal(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = createSignal(false);
  const [isEditModalOpen, setIsEditModalOpen] = createSignal(false);
  const [createInitialId, setCreateInitialId] = createSignal(1);
  const [createInitialLabel, setCreateInitialLabel] = createSignal("");
  const [pendingOverwrite, setPendingOverwrite] = createSignal<{
    id: number;
    label: string;
    uid: string;
    existingLabel: string;
  }>();
  const [editInitialId, setEditInitialId] = createSignal(1);
  const [editInitialLabel, setEditInitialLabel] = createSignal("");
  const [editingClipUid, setEditingClipUid] = createSignal<string | null>(null);
  const [labelEditRequest, setLabelEditRequest] =
    createSignal<CrudListDataGridEditRequest<ClipEntry>>();
  const [listSelectionRequest, setListSelectionRequest] =
    createSignal<CrudListDataGridSelectionRequest<ClipEntry>>();
  const [editingCardLabelUid, setEditingCardLabelUid] = createSignal<
    string | null
  >(null);

  /** Returns whether any modal currently blocks clip list interaction. */
  const isModalOpen = () =>
    isDeleteModalOpen() ||
    isCreateModalOpen() ||
    isEditModalOpen() ||
    !!pendingOverwrite();

  /** Finds the lowest positive numeric clip ID not currently in use. */
  const nextClipId = () => {
    const existing = options
      .allDisplayRows()
      .map(([clip]) => clip.identifiers.id);
    let next = 1;
    while (existing.includes(next)) next += 1;
    return next;
  };

  /** Opens the create dialog with a generated ID and default label. */
  const openCreate = () => {
    if (isDeleteModalOpen() || isEditModalOpen()) return;
    const id = nextClipId();
    setCreateInitialId(id);
    setCreateInitialLabel(`Clip ${id}`);
    setIsCreateModalOpen(true);
  };

  /** Stores a fresh clip configuration, preserving identity when overwriting. */
  const createClip = (
    payload: { id: number; label: string },
    uid: string = crypto.randomUUID(),
  ) => {
    storeClip({
      identifiers: {
        id: payload.id,
        uid,
        label: payload.label,
      },
      source: undefined,
      priority: 0,
      options: {
        auto_release: true,
        deactivate_on_sequence_end: false,
      },
    });
    setIsCreateModalOpen(false);
  };

  /** Requests confirmation rather than silently rejecting an occupied clip ID. */
  const submitCreate = (payload: { id: number; label: string }) => {
    const existing = Object.values(options.clips()).find(
      ([clip]) => clip.identifiers.id === payload.id,
    )?.[0];
    if (existing) {
      setCreateInitialId(payload.id);
      setCreateInitialLabel(payload.label);
      setIsCreateModalOpen(false);
      setPendingOverwrite({
        ...payload,
        uid: existing.identifiers.uid,
        existingLabel: existing.identifiers.label,
      });
      return;
    }
    createClip(payload);
  };

  /** Returns to the creation form without modifying the existing clip. */
  const cancelOverwrite = () => {
    setPendingOverwrite(undefined);
    setIsCreateModalOpen(true);
  };

  /** Rechecks identity so confirmation never replaces a different, newly assigned clip. */
  const confirmOverwrite = () => {
    const pending = pendingOverwrite();
    if (!pending) return;
    const existing = Object.values(options.clips()).find(
      ([clip]) => clip.identifiers.id === pending.id,
    )?.[0];
    setPendingOverwrite(undefined);
    if (existing && existing.identifiers.uid !== pending.uid) {
      submitCreate(pending);
      return;
    }
    createClip(pending, existing?.identifiers.uid);
  };

  /** Opens the edit dialog for the single selected clip. */
  const openEditSelected = () => {
    if (isDeleteModalOpen() || isCreateModalOpen()) return;
    const [clipUid] = options.selectedClipUids();
    if (!clipUid) return;
    const clipEntry = options.clips()[clipUid];
    if (!clipEntry) return;

    setEditingClipUid(clipUid);
    setEditInitialId(clipEntry[0].identifiers.id);
    setEditInitialLabel(clipEntry[0].identifiers.label);
    setIsEditModalOpen(true);
  };

  /** Stores a clip label change without changing its numeric ID. */
  const updateLabel = (clipEntry: ClipEntry, label: string) => {
    const [clip] = clipEntry;
    if (label === clip.identifiers.label) return;
    storeClip({
      ...clip,
      identifiers: { ...clip.identifiers, label },
    });
  };

  /** Starts inline label editing in the active list or card presentation. */
  const requestLabelEdit = (clipEntry: ClipEntry) => {
    if (options.viewMode() !== "list") {
      setEditingCardLabelUid(clipEntry[0].identifiers.uid);
      return;
    }
    setLabelEditRequest({
      row: clipEntry,
      columnId: "label",
      requestId: Date.now(),
    });
  };

  /** Applies numeric ID and label changes from the clip edit dialog. */
  const submitEdit = (payload: { id: number; label: string }) => {
    const clipUid = editingClipUid();
    const clipEntry = clipUid ? options.clips()[clipUid] : undefined;
    if (!clipEntry) {
      setIsEditModalOpen(false);
      return;
    }

    const [clip] = clipEntry;
    if (payload.id !== clip.identifiers.id) {
      renameClip(clip.identifiers.id, payload.id);
    }
    if (
      payload.id !== clip.identifiers.id ||
      payload.label !== clip.identifiers.label
    ) {
      storeClip({
        ...clip,
        identifiers: {
          ...clip.identifiers,
          id: payload.id,
          label: payload.label,
        },
      });
    }

    setIsEditModalOpen(false);
    setEditingClipUid(null);
    options.setSelectionModeEnabled(false);
  };

  /** Opens delete confirmation when one or more clips are selected. */
  const openDeleteSelected = () => {
    if (isCreateModalOpen() || isEditModalOpen()) return;
    if (options.selectedCount() === 0) return;
    setIsDeleteModalOpen(true);
  };

  /** Deletes all selected clips and resets selection state. */
  const confirmDeleteSelected = () => {
    const clipMap = options.clips();
    for (const uid of options.selectedClipUids()) {
      const clipEntry = clipMap[uid];
      if (clipEntry) deleteClip(clipEntry[0].identifiers.id);
    }
    options.setSelectedClipUids([]);
    setIsDeleteModalOpen(false);
    options.setSelectionModeEnabled(false);
  };

  return {
    pendingOverwrite,
    cancelOverwrite,
    confirmOverwrite,
    createInitialId,
    createInitialLabel,
    editInitialId,
    editInitialLabel,
    editingCardLabelUid,
    isCreateModalOpen,
    isDeleteModalOpen,
    isEditModalOpen,
    isModalOpen,
    labelEditRequest,
    listSelectionRequest,
    confirmDeleteSelected,
    openCreate,
    openDeleteSelected,
    openEditSelected,
    requestLabelEdit,
    setEditingCardLabelUid,
    setIsCreateModalOpen,
    setIsDeleteModalOpen,
    setIsEditModalOpen,
    setListSelectionRequest,
    submitCreate,
    submitEdit,
    updateLabel,
  };
}
