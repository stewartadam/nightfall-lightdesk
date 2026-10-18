// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, Show } from "solid-js";
import { InlineRenameField } from "../components/ui/inline-rename-field";
import { Button } from "../components/ui/visual-language/button";
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

/** Names the asynchronous sample refuses, standing in for a backend that rejects duplicates. */
const TAKEN_NAMES = new Set(["Side wash", "House lights"]);

/**
 * Shows the shared inline rename field's commit, blur, and cancel contract with a local name, and
 * an asynchronous save that stays open with its draft when the save is refused.
 */
export function InlineRenameDemo() {
  const [name, setName] = createSignal("Front wash");
  const [editing, setEditing] = createSignal(false);
  const [asyncName, setAsyncName] = createSignal("Overhead spots");
  const [asyncEditing, setAsyncEditing] = createSignal(false);
  const [asyncStatus, setAsyncStatus] = createSignal("");

  /** Saves after a short delay, refusing names another sample object already uses. */
  const saveAsyncName = async (next: string) => {
    setAsyncStatus("Saving…");
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (TAKEN_NAMES.has(next)) {
      setAsyncStatus(`“${next}” is already used`);
      return false;
    }
    setAsyncName(next);
    setAsyncStatus("");
    return true;
  };

  return (
    <section class="properties lab-panel" aria-label="Inline rename examples">
      <div class="eyebrow">INLINE RENAME</div>
      <h2>Edit in place.</h2>
      <div class="widget-sample-card">
        <div class="section-label">Group 1 · 12 fixtures</div>
        <div class="widget-rename-row">
          <Show
            when={editing()}
            fallback={<span class="widget-object-name">{name()}</span>}
          >
            <InlineRenameField
              ariaLabel="Group name"
              value={name()}
              onCommit={setName}
              onClose={() => setEditing(false)}
            />
          </Show>
          <Button disabled={editing()} onClick={() => setEditing(true)}>
            Rename
          </Button>
        </div>
      </div>
      <p class="field-help">
        Enter or leaving the field saves the name. Escape discards the draft. An
        empty or unchanged name keeps the saved one.
      </p>
      <p class="field-help" role="status">
        Saved name: {name()}
      </p>
      <div class="widget-sample-card">
        <div class="section-label">Group 3 · saved by the backend</div>
        <div class="widget-rename-row">
          <Show
            when={asyncEditing()}
            fallback={<span class="widget-object-name">{asyncName()}</span>}
          >
            <InlineRenameField
              ariaLabel="Backend group name"
              value={asyncName()}
              onCommit={saveAsyncName}
              onClose={() => setAsyncEditing(false)}
            />
          </Show>
          <Button
            disabled={asyncEditing()}
            onClick={() => {
              setAsyncStatus("");
              setAsyncEditing(true);
            }}
          >
            Rename
          </Button>
        </div>
      </div>
      <p class="field-help">
        The field is read-only while the save runs. “Side wash” and “House
        lights” are refused, which keeps the field open with the draft.
      </p>
      <p class="field-help" role="status" aria-label="Backend save status">
        {asyncStatus()}
      </p>
    </section>
  );
}
