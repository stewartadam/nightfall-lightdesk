// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  commandFailure,
  commandOutputValue,
} from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import {
  applyFixtureDraftUpdated,
  replaceFixtureDrafts,
} from "../../../state/fixture-drafts";
import type * as types from "../../../types";

/** Command module the backend registers fixture-editor commands under. */
const MODULE = "FixtureEditorCommand";

/** A failed fixture-editor command, keeping the backend's error code for branching. */
export class FixtureEditorError extends Error {
  /** Backend error code, e.g. `fixture_editor.file_exists`. */
  readonly code: string;

  /** Wraps a backend failure, using its operator-facing message as the error message. */
  constructor(failure: types.CommandError) {
    super(failure.message);
    this.code = failure.code;
  }
}

/** Error code of a save that would replace an existing library file. */
export const FILE_EXISTS_CODE = "fixture_editor.file_exists";

/** Sends one fixture-editor command and returns its output, throwing its failure with its code. */
async function invokeEditor(
  command: types.FixtureEditorCommand,
): Promise<unknown> {
  const result = await commandClient.invoke(MODULE, command);
  const failure = commandFailure(result);
  if (failure) throw new FixtureEditorError(failure);
  return commandOutputValue(result);
}

/**
 * Sends a command that returns a draft's new view, and stores the view at
 * once so this window shows the change before the broadcast arrives.
 */
async function invokeForDraft(
  command: types.FixtureEditorCommand,
  actionName: string,
): Promise<types.FixtureDraftView> {
  const output = await invokeEditor(command);
  if (!isDraftView(output)) {
    throw new Error("The backend did not return the draft");
  }
  applyFixtureDraftUpdated(output, actionName);
  return output;
}

/** Returns whether a command output has the shape of a draft view. */
function isDraftView(value: unknown): value is types.FixtureDraftView {
  return (
    typeof value === "object" &&
    value !== null &&
    "draft_id" in value &&
    typeof value.draft_id === "number" &&
    "info" in value
  );
}

/**
 * Opens a draft from a template, a blank profile or a library fixture and
 * returns its view. The view is stored right away, since the result can
 * arrive before the broadcast that adds the draft in every window.
 */
export function openDraft(
  source: types.DraftSource,
): Promise<types.FixtureDraftView> {
  return invokeForDraft({ type: "OpenDraft", data: { source } }, "Open draft");
}

/**
 * Applies one edit to the draft as this window last saw it. The backend
 * rejects the edit as stale when another window changed the draft first, so
 * an edit never lands on a channel that moved.
 */
export function editDraft(
  draft: types.FixtureDraftView,
  edit: types.DraftEdit,
): Promise<types.FixtureDraftView> {
  return invokeForDraft(
    {
      type: "EditDraft",
      data: { draft_id: draft.draft_id, base_version: draft.version, edit },
    },
    `Edit draft: ${edit.type}`,
  );
}

/** Reverts the draft's last edit. */
export function undoDraft(
  draftId: types.DraftId,
): Promise<types.FixtureDraftView> {
  return invokeForDraft(
    { type: "UndoDraft", data: { draft_id: draftId } },
    "Undo draft",
  );
}

/** Reapplies the draft's last reverted edit. */
export function redoDraft(
  draftId: types.DraftId,
): Promise<types.FixtureDraftView> {
  return invokeForDraft(
    { type: "RedoDraft", data: { draft_id: draftId } },
    "Redo draft",
  );
}

/** What a save writes: the library file name, whether it may replace a file, and a revision note. */
export interface SaveOptions {
  /** File name; the draft's own file, or one built from its names, when omitted. */
  fileName?: string;
  overwrite: boolean;
  note?: string;
}

/**
 * Saves the draft into the fixture library. A save that would replace a file
 * this draft did not write fails with `FILE_EXISTS_CODE`, so the caller can
 * ask first and save again with `overwrite`.
 */
export function saveDraft(
  draftId: types.DraftId,
  options: SaveOptions,
): Promise<types.FixtureDraftView> {
  return invokeForDraft(
    {
      type: "SaveDraft",
      data: {
        draft_id: draftId,
        file_name: options.fileName || undefined,
        overwrite: options.overwrite,
        note: options.note || undefined,
      },
    },
    "Save draft",
  );
}

/** Returns whether a command output has the shape of a catalog attribute. */
function isAttributeOption(
  value: unknown,
): value is types.DraftAttributeOption {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "group" in value &&
    "pretty" in value &&
    typeof value.pretty === "string"
  );
}

/** Loads the standard attributes a channel can be created for. */
export async function listAttributes(): Promise<types.DraftAttributeOption[]> {
  const output = await invokeEditor({ type: "ListAttributes" });
  if (!Array.isArray(output) || !output.every(isAttributeOption)) {
    throw new Error("The backend did not return the attribute catalog");
  }
  return output;
}

/** Loads every open draft into the shared store, replacing what this window held. */
export async function refreshDrafts(): Promise<void> {
  const output = await invokeEditor({ type: "ListDrafts" });
  if (!Array.isArray(output) || !output.every(isDraftView)) {
    throw new Error("The backend did not return the open drafts");
  }
  replaceFixtureDrafts(output);
}

/** Closes a draft without saving it; the backend broadcasts the closure to every window. */
export async function discardDraft(draftId: types.DraftId): Promise<void> {
  await invokeEditor({ type: "DiscardDraft", data: { draft_id: draftId } });
}
