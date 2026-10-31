// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  commandOutputValue,
  requireCommandSuccess,
} from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import {
  applyFixtureDraftUpdated,
  replaceFixtureDrafts,
} from "../../../state/fixture-drafts";
import type * as types from "../../../types";

/** Command module the backend registers fixture-editor commands under. */
const MODULE = "FixtureEditorCommand";

/** Sends one fixture-editor command and returns its output, throwing its failure message. */
async function invokeEditor(
  command: types.FixtureEditorCommand,
): Promise<unknown> {
  const result = await commandClient.invoke(MODULE, command);
  requireCommandSuccess(result);
  return commandOutputValue(result);
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
export async function openDraft(
  source: types.DraftSource,
): Promise<types.FixtureDraftView> {
  const output = await invokeEditor({ type: "OpenDraft", data: { source } });
  if (!isDraftView(output)) {
    throw new Error("The backend did not return the opened draft");
  }
  applyFixtureDraftUpdated(output, "Open draft");
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
