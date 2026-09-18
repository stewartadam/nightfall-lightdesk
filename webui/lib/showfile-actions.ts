// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { dockApi } from "../state/appStores";
import type * as types from "../types";
import { requireCommandSuccess } from "./command-result";
import { createActivePanelLayout } from "./dockview-active-layout";
import { engineRuntime } from "./engine-runtime";
import {
  persistCurrentShowfileName,
  showfileLoadCommandForName,
} from "./showfile-loading";
import { parseSimpleShowfileSaveCommand } from "./showfile-save-command-parser";

export { promptForNewShowfileName } from "./new-showfile-name-prompt";

export type OpenShowfileSelection =
  | { type: "new"; name: string }
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

/** Captures the current Dockview active layout when one is available. */
function activePanelLayoutForSave(): types.ActivePanelLayout | undefined {
  const api = dockApi.get();
  return api ? createActivePanelLayout(api) : undefined;
}

/** Builds save options from the UI state available at the moment save is requested. */
export function currentShowfileSaveOptions(): types.ShowfileSaveOptions {
  const activePanelLayout = activePanelLayoutForSave();
  return activePanelLayout ? { activePanelLayout } : {};
}

/** Builds a plain showfile save command with current UI save options attached. */
export function saveShowfileCommand(): types.DeskCommand {
  return { type: "SaveShowfile", data: currentShowfileSaveOptions() };
}

/** Builds a named showfile save command with current UI save options attached. */
export function saveNamedShowfileCommand(name: string): types.DeskCommand {
  return {
    type: "SaveNamedShowfile",
    data: {
      name,
      options: currentShowfileSaveOptions(),
    },
  };
}

/** Builds a draft save command with current UI save options attached. */
export function saveDraftShowfileCommand(): types.DeskCommand {
  return { type: "SaveDraftShowfile", data: currentShowfileSaveOptions() };
}

/** Converts simple command-line save input into a layout-aware save command. */
export function showfileSaveCommandForInput(
  commandInput: string,
): types.DeskCommand | null {
  const parsed = parseSimpleShowfileSaveCommand(commandInput);
  if (!parsed) {
    return null;
  }

  return parsed.name
    ? saveNamedShowfileCommand(parsed.name)
    : saveShowfileCommand();
}

/** Returns the command payload for starting a new showfile. */
function newShowfileCommand(name?: string): types.DeskCommand {
  return name
    ? { type: "NewNamedShowfile", data: name }
    : { type: "NewShowfile" };
}

/** Starts a new showfile through the backend. */
export function newShowfile(name?: string): void {
  sendDeskCommand(newShowfileCommand(name));
}

/** Starts a new showfile and resolves after the backend confirms it completed. */
export async function newShowfileAndAwait(name?: string): Promise<void> {
  await sendDeskCommandAndAwait(newShowfileCommand(name));
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
    newShowfile(selection.name);
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
