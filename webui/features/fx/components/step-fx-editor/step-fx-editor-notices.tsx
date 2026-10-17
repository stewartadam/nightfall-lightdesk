// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Button } from "../../../../components/ui/visual-language/button";
import type { StepFxEditorSession } from "../../controllers/step-fx-editor-view-controller";

/** Warns when the stored definition was deleted or replaced while this draft was open. */
export function StepFxEditorNotices(props: {
  session: StepFxEditorSession;
  onCloseEditor: () => void;
}) {
  return (
    <>
      <Show when={props.session.deletedExternally()}>
        <div
          class="flex shrink-0 items-center gap-2 border-b border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100"
          role="alert"
        >
          This Step FX was deleted elsewhere. This local draft can no longer be
          saved.
          <Button size="compact" onClick={() => props.onCloseEditor()}>
            Close editor
          </Button>
        </div>
      </Show>
      <Show
        when={props.session.conflict() && !props.session.deletedExternally()}
      >
        <div class="flex shrink-0 items-center gap-2 border-b border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
          This Step FX changed elsewhere while this draft has unsaved edits.
          <Button size="compact" onClick={() => props.session.reloadStored()}>
            Reload stored
          </Button>
          <Button
            size="compact"
            onClick={() => props.session.overwriteConflict()}
          >
            Keep draft
          </Button>
        </div>
      </Show>
    </>
  );
}
