// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import { commandFailure } from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import type { EngineSessionScope } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import type { AnyWsMessage } from "../../../lib/ws/types";
import type * as types from "../../../types";
import { refreshDrafts } from "./fixture-editor-client";

const log = getLogger(import.meta.url);

/**
 * Message types the editor window handles: command results and notices, its drafts, the
 * fixture library listing, the world replacement that may close drafts, and desk commands that
 * keep its logging in step with the backend. The engine sends the window nothing else, so the
 * show's state and streams never reach it.
 */
export const FIXTURE_EDITOR_MESSAGE_TYPES = [
  "CommandResult",
  "CommandNotice",
  "FixtureDraftUpdated",
  "FixtureDraftClosed",
  "ListAvailableFixturesResponse",
  "WorldReplaced",
  "DeskCommand",
] as const satisfies readonly AnyWsMessage["type"][];

/** Why the open drafts could not be listed on the last attempt, or null once they were. */
export const draftListError = atom<string | null>(null);

/** Loads the open drafts and the fixture library listing, which is all the editor shows. */
function requestEditorState(): void {
  refreshDrafts().then(
    () => draftListError.set(null),
    (cause: unknown) => {
      log.error("Could not list fixture drafts", { error: cause });
      draftListError.set(
        cause instanceof Error ? cause.message : String(cause),
      );
    },
  );
  commandClient
    .invoke("FixtureLibraryCommand", {
      type: "ListAvailableFixtures",
    } satisfies types.FixtureLibraryCommand)
    .then((result) => {
      const failure = commandFailure(result);
      if (failure) {
        log.error("Could not list library fixtures", { error: failure });
      }
    })
    .catch((cause: unknown) => {
      log.error("Could not list library fixtures", { error: cause });
    });
}

/** Limits the editor window's engine connection to drafts and the fixture library. */
export const FIXTURE_EDITOR_SESSION: EngineSessionScope = {
  messageTypes: FIXTURE_EDITOR_MESSAGE_TYPES,
  requestSessionState: requestEditorState,
};
