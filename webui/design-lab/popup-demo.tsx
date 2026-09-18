// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { Input } from "../components/ui/form-controls";
import { Button } from "../components/ui/visual-language/button";
import DeleteConfirmModal from "../components/widgets/delete-confirm-dialog";
import EntityEditorModal from "../components/widgets/entity-editor-dialog";

/** Launches production dialogs and Dockview floating/window examples using local sample state. */
export function PopupDemo(props: {
  onFloat: () => void;
  onPopout: () => void;
}) {
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [name, setName] = createSignal("Front wash");
  const [notice, setNotice] = createSignal(
    "Sample dialogs only change this panel.",
  );
  let trigger: HTMLButtonElement | undefined;
  /** Closes dialogs and returns keyboard focus to their launching control. */
  const closeDialogs = () => {
    setEditorOpen(false);
    setConfirmOpen(false);
    trigger?.focus();
  };
  return (
    <section class="properties lab-panel" aria-label="Popup examples">
      <div class="eyebrow">POPUPS & POPOUTS</div>
      <h2>Bring the right controls forward.</h2>
      <div class="property-section">
        <div class="section-label">Modal dialogs</div>
        <div class="button-samples">
          <Button
            onClick={(event) => {
              trigger = event.currentTarget;
              setEditorOpen(true);
            }}
          >
            Open editor dialog
          </Button>
          <Button
            variant="danger"
            onClick={(event) => {
              trigger = event.currentTarget;
              setConfirmOpen(true);
            }}
          >
            Open confirmation
          </Button>
        </div>
        <p class="field-help">
          Edit a sample group or try a destructive confirmation. Escape
          dismisses either dialog.
        </p>
      </div>
      <div class="property-section">
        <div class="section-label">Detached panels</div>
        <div class="button-samples">
          <Button onClick={props.onFloat}>Open floating panel</Button>
          <Button onClick={props.onPopout}>Open pop-out window</Button>
        </div>
        <p class="field-help">
          Move the preview within this workspace or into its own window. Its
          note stays with the panel.
        </p>
      </div>
      <p class="field-help" role="status">
        {notice()}
      </p>
      <EntityEditorModal
        isOpen={editorOpen()}
        title="Edit sample group"
        submitLabel="Save sample"
        initialId={42}
        initialLabel={name()}
        onCancel={closeDialogs}
        onSubmit={(value) => {
          setName(value.label);
          setNotice(`Saved sample: ${value.label}`);
          closeDialogs();
        }}
      />
      <DeleteConfirmModal
        isOpen={confirmOpen()}
        title="Delete sample group?"
        message={`Remove “${name()}” from this demo?`}
        confirmLabel="Delete sample"
        onCancel={closeDialogs}
        onConfirm={() => {
          setNotice(`Deleted sample: ${name()}`);
          closeDialogs();
        }}
      />
    </section>
  );
}

/** Keeps editable sample state in a real Dockview panel as it moves between host windows. */
export function PopoutPreview(props: { onClose: () => void }) {
  const [note, setNote] = createSignal("Ready for the next cue");
  return (
    <section class="properties lab-panel" aria-label="Detached preview">
      <div class="eyebrow">LIVE PANEL PREVIEW</div>
      <h2>A little room to work.</h2>
      <label class="demo-input-label">
        Preview note
        <Input
          density="comfortable"
          value={note()}
          onInput={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <p class="field-help">
        This is local sample state. Closing a separate window returns the panel
        to the workspace.
      </p>
      <Button onClick={props.onClose}>Close preview panel</Button>
    </section>
  );
}
