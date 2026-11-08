// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PencilRulerIcon } from "@squidlab/phosphor-solid/pencil-ruler";
import { Show } from "solid-js";
import { useUiAction } from "../../components/providers/command-registry";
import { getLogger } from "../../lib/logger";
import { isEmbeddedDemoRuntime } from "../../lib/runtime-config";
import { pushToast } from "../../state/notifications";
import { openFixtureEditorWindow } from "./services/editor-window";

const log = getLogger(import.meta.url);

/** UI action ID of the command that opens the fixture editor window. */
export const OPEN_FIXTURE_EDITOR_ACTION_ID = "open-fixture-editor";

/** Opens the editor window, reporting a failure such as a blocked pop-up as a toast. */
function openEditor(): void {
  void openFixtureEditorWindow().catch((error: unknown) => {
    log.error("Could not open the fixture editor", { error });
    pushToast(
      "error",
      error instanceof Error
        ? error.message
        : "Could not open the fixture editor.",
    );
  });
}

/** Registers the palette command; the desktop View menu lists it through the same action. */
function OpenFixtureEditorCommand() {
  useUiAction({
    id: OPEN_FIXTURE_EDITOR_ACTION_ID,
    name: "Fixture Editor",
    description:
      "Open the fixture editor window to build or change GDTF fixture profiles",
    category: "Fixtures",
    icon: PencilRulerIcon,
    execute: openEditor,
  });
  return null;
}

/**
 * Registers the fixture editor command. The browser demo has no fixture
 * library on disk to save into, so the command is left out there.
 */
export default function FixtureEditorCommands() {
  return (
    <Show when={!isEmbeddedDemoRuntime()}>
      <OpenFixtureEditorCommand />
    </Show>
  );
}
