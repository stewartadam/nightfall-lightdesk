// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { Button } from "../components/ui/visual-language/button";
import CrudInlineLabelEditor from "../components/widgets/crud/crud-inline-label-editor";
import ObjectSelector from "../components/widgets/object-selector";
import "./widget-demos.css";

const sampleObjects = [
  { id: "front", label: "Front wash", detail: "Group 1 · 12 fixtures" },
  { id: "side", label: "Side wash", detail: "Group 2 · 8 fixtures" },
  { id: "spots", label: "Overhead spots", detail: "Group 3 · 6 fixtures" },
  { id: "house", label: "House lights", detail: "Group 4 · 24 fixtures" },
];

/** Demonstrates searchable object rows with secondary text, keyboard selection, and empty results. */
export function ObjectSelectorDemo() {
  const [selected, setSelected] = createSignal(sampleObjects[0]);
  return (
    <section class="properties lab-panel" aria-label="Object selector examples">
      <div class="eyebrow">OBJECT SELECTOR</div>
      <h2>Find the right object.</h2>
      <p class="field-help">
        Search names or details. Use Up and Down in the search field, then Enter
        to select.
      </p>
      <ObjectSelector
        items={sampleObjects}
        selectedKey={selected().id}
        onSelect={setSelected}
        getKey={(item) => item.id}
        getPrimaryText={(item) => item.label}
        getSecondaryText={(item) => item.detail}
        ariaLabel="Search sample objects"
        placeholder="Search groups or fixture counts…"
      />
      <p class="field-help" role="status">
        Selected: {selected().label}
      </p>
    </section>
  );
}

/** Shows the production inline label editor's commit, blur, and cancel behavior with a local name. */
export function InlineRenameDemo() {
  const [name, setName] = createSignal("Front wash");
  const [editing, setEditing] = createSignal(false);
  return (
    <section class="properties lab-panel" aria-label="Inline rename examples">
      <div class="eyebrow">INLINE RENAME</div>
      <h2>Edit in place.</h2>
      <div class="widget-sample-card">
        <div class="section-label">Group 1 · 12 fixtures</div>
        <div class="widget-rename-row">
          <CrudInlineLabelEditor
            ariaLabel="Group name"
            class="widget-object-name"
            editing={editing()}
            label={name()}
            onCommit={setName}
            onCancel={() => setEditing(false)}
          >
            {name()}
          </CrudInlineLabelEditor>
          <Button disabled={editing()} onClick={() => setEditing(true)}>
            Rename
          </Button>
        </div>
      </div>
      <p class="field-help">
        Enter or leaving the field saves the name. Escape discards the draft.
      </p>
      <p class="field-help" role="status">
        Saved name: {name()}
      </p>
    </section>
  );
}
