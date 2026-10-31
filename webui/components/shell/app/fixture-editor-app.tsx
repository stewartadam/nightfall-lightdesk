// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FixtureEditorWindow } from "../../../features/fixture-editor";
import DiagnosticsRuntime from "../runtime/diagnostics";
import EngineConnection from "../runtime/engine-connection";

/**
 * Root of the separate fixture editor window. It connects to the engine as
 * its own client and skips the workspace shell and startup prompts, which
 * belong to the main window.
 */
export default function FixtureEditorApp() {
  return (
    <div class="contents" data-app-root="fixture-editor">
      <EngineConnection />
      <DiagnosticsRuntime />
      <FixtureEditorWindow />
    </div>
  );
}
