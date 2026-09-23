// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../../../components/widgets/entity-editor-dialog";

interface ClipEditorPayload {
  id: number;
  label: string;
}

interface ClipEditorDialogsProps {
  overwrite?: { id: number; existingLabel: string };
  onCancelOverwrite: () => void;
  onOverwrite: () => void;
  createOpen: boolean;
  createInitialId: number;
  createInitialLabel: string;
  editOpen: boolean;
  editInitialId: number;
  editInitialLabel: string;
  deleteOpen: boolean;
  selectedCount: number;
  onCancelCreate: () => void;
  onCancelEdit: () => void;
  onCancelDelete: () => void;
  onCreate: (payload: ClipEditorPayload) => void;
  onEdit: (payload: ClipEditorPayload) => void;
  onDelete: () => void;
}

/** Renders clip create, edit, and delete dialogs from controller-owned state. */
export function ClipEditorDialogs(props: ClipEditorDialogsProps) {
  return (
    <>
      <DeleteConfirmModal
        isOpen={!!props.overwrite}
        title="Overwrite clip?"
        message={`Clip ${props.overwrite?.id}: ${props.overwrite?.existingLabel} already exists. Overwrite it with the new clip? Its source and playback options will be reset; existing references will still point to this clip.`}
        confirmLabel="Overwrite"
        onCancel={props.onCancelOverwrite}
        onConfirm={props.onOverwrite}
      />
      <EntityEditorModal
        isOpen={props.createOpen}
        title="Create clip"
        submitLabel="Create"
        initialId={props.createInitialId}
        initialLabel={props.createInitialLabel}
        onCancel={props.onCancelCreate}
        onSubmit={props.onCreate}
      />
      <EntityEditorModal
        isOpen={props.editOpen}
        title="Edit clip"
        submitLabel="Save"
        initialId={props.editInitialId}
        initialLabel={props.editInitialLabel}
        onCancel={props.onCancelEdit}
        onSubmit={props.onEdit}
      />
      <DeleteConfirmModal
        isOpen={props.deleteOpen}
        title="Delete selected clips"
        message={`Delete ${props.selectedCount} selected clip(s)? This action cannot be undone.`}
        confirmLabel="Delete"
        onCancel={props.onCancelDelete}
        onConfirm={props.onDelete}
      />
    </>
  );
}
