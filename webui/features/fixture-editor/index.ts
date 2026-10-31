// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { lazy } from "solid-js";

export {
  default as FixtureEditorCommands,
  OPEN_FIXTURE_EDITOR_ACTION_ID,
} from "./fixture-editor-commands";
export { isFixtureEditorWindow } from "./services/editor-window";

/**
 * The editor window's root, loaded on demand so the main workspace, which
 * only registers the command that opens it, does not bundle the editor.
 */
export const FixtureEditorWindow = lazy(
  () => import("./components/fixture-editor-window"),
);
