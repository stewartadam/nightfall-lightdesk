// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  FIXTURE_EDITOR_SESSION,
  FixtureEditorWindow,
} from "../../../features/fixture-editor";
import DiagnosticsRuntime from "../runtime/diagnostics";
import EngineConnection from "../runtime/engine-connection";

/**
 * Root of the separate fixture editor window. It connects to the engine as
 * its own client, limited to drafts and the fixture library so the show's
 * state never streams to it, and skips the workspace shell and startup
 * prompts, which belong to the main window.
 */
export default function FixtureEditorApp() {
  return (
    <div class="contents" data-app-root="fixture-editor">
      <EngineConnection scope={FIXTURE_EDITOR_SESSION} />
      <DiagnosticsRuntime />
      <FixtureEditorWindow />
    </div>
  );
}
