// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { requireCommandSuccess } from "./command-result";
import { engineRuntime } from "./engine-runtime";
import {
  persistCurrentShowfileName,
  showfileLoadCommandForName,
} from "./showfile-loading";

export { promptForNewShowfile } from "./new-showfile-name-prompt";

export type OpenShowfileSelection =
  | ({ type: "new" } & types.NewShowfileOptions)
  | { type: "showfile"; name: string; discardDraft?: boolean }
  | { type: "draft"; showfileName: string }
  | { type: "revision"; showfileName: string; revisionName: string };

/** Sends a DeskCommand through the websocket showfile action service. */
function sendDeskCommand(command: types.DeskCommand): void {
  engineRuntime.sendCommand({ module: "DeskCommand", command });
}

/** Sends a DeskCommand and waits for the backend command result. */
async function sendDeskCommandAndAwait(
  command: types.DeskCommand,
): Promise<void> {
  const result = await engineRuntime.sendCommandAndAwait({
    module: "DeskCommand",
    command,
  });
  requireCommandSuccess(result);
}

/** Builds a plain showfile save command. */
export function saveShowfileCommand(): types.DeskCommand {
  return { type: "SaveShowfile" };
}

/** Builds a save command targeting a named showfile folder. */
export function saveNamedShowfileCommand(name: string): types.DeskCommand {
  return { type: "SaveNamedShowfile", data: name };
}

/** Builds a draft save command for the current showfile. */
export function saveDraftShowfileCommand(): types.DeskCommand {
  return { type: "SaveDraftShowfile" };
}

/** Returns the command payload for starting a new showfile. */
function newShowfileCommand(
  options?: types.NewShowfileOptions,
): types.DeskCommand {
  return options
    ? { type: "NewNamedShowfile", data: options }
    : { type: "NewShowfile" };
}

/** Starts a new showfile through the backend. */
export function newShowfile(options?: types.NewShowfileOptions): void {
  sendDeskCommand(newShowfileCommand(options));
}

/** Starts a new showfile and resolves after the backend confirms it completed. */
export async function newShowfileAndAwait(
  options?: types.NewShowfileOptions,
): Promise<void> {
  await sendDeskCommandAndAwait(newShowfileCommand(options));
}

/** Saves the current showfile through the backend. */
export function saveShowfile(): void {
  sendDeskCommand(saveShowfileCommand());
}

/** Imports selected showfile domains through the backend. */
export function importShowfile(options: types.ShowfileImportOptions): void {
  sendDeskCommand({ type: "ImportShowfile", data: options });
}

/** Sends a showfile load command for the selected showfile name. */
export function loadShowfileName(name: string): void {
  const { command } = showfileLoadCommandForName(name);
  sendDeskCommand(command);
}

/** Loads a showfile and resolves after the backend confirms the load completed. */
export async function loadShowfileNameAndAwait(name: string): Promise<void> {
  const { command, showfileName } = showfileLoadCommandForName(name);
  await sendDeskCommandAndAwait(command);
  persistCurrentShowfileName(showfileName);
}

/** Loads a recoverable draft showfile through the backend. */
export function loadDraftShowfile(showfileName: string): void {
  sendDeskCommand({
    type: "LoadDraftShowfile",
    data: showfileName,
  });
}

/** Loads a recoverable draft and resolves after the backend confirms the load. */
export async function loadDraftShowfileAndAwait(
  showfileName: string,
): Promise<void> {
  await sendDeskCommandAndAwait({
    type: "LoadDraftShowfile",
    data: showfileName,
  });
  persistCurrentShowfileName(showfileName);
}

/** Discards a recoverable draft showfile through the backend. */
export function discardDraftShowfile(showfileName: string): void {
  sendDeskCommand({
    type: "DiscardDraftShowfile",
    data: showfileName,
  });
}

/** Discards a recoverable draft and resolves after the backend confirms deletion. */
export async function discardDraftShowfileAndAwait(
  showfileName: string,
): Promise<void> {
  await sendDeskCommandAndAwait({
    type: "DiscardDraftShowfile",
    data: showfileName,
  });
}

/** Moves a show that is not open, with its draft and backups, into the backend trash. */
export async function deleteShowfileAndAwait(
  showfileName: string,
): Promise<void> {
  await sendDeskCommandAndAwait({
    type: "DeleteShowfile",
    data: showfileName,
  });
}

/** Restores a deleted show from its trash entry and resolves once it is listed again. */
export async function restoreDeletedShowfileAndAwait(
  trashEntryId: string,
): Promise<void> {
  await sendDeskCommandAndAwait({
    type: "RestoreDeletedShowfile",
    data: trashEntryId,
  });
}

/** Permanently removes every deleted show held in the backend trash. */
export async function emptyShowfileTrashAndAwait(): Promise<void> {
  await sendDeskCommandAndAwait({ type: "EmptyShowfileTrash" });
}

/** Load a backup revision into working state without replacing its saved showfile. */
export async function loadShowfileRevisionAndAwait(
  showfileName: string,
  revisionName: string,
): Promise<void> {
  await sendDeskCommandAndAwait({
    type: "LoadShowfileRevision",
    data: { showfileName, revisionName },
  });
  persistCurrentShowfileName(showfileName);
}

/** Open the selected showfile, draft, or backup revision. */
export async function openShowfileSelection(
  selection: OpenShowfileSelection,
): Promise<void> {
  if (selection.type === "new") {
    newShowfile(selection);
    return;
  }

  if (selection.type === "draft") {
    loadDraftShowfile(selection.showfileName);
    return;
  }

  if (selection.type === "revision") {
    await loadShowfileRevisionAndAwait(
      selection.showfileName,
      selection.revisionName,
    );
    return;
  }

  if (selection.discardDraft) {
    discardDraftShowfile(selection.name);
  }
  loadShowfileName(selection.name);
}
