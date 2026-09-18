// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { createMemo, createSignal, For } from "solid-js";
import { ShortcutKeys } from "../components/overlays/keyboard-shortcuts";
import { useCommandPalette } from "../components/providers/command-registry";
import { Input } from "../components/ui/form-controls";
import { Button } from "../components/ui/visual-language/button";
import { allShortcuts } from "../lib/keyboardShortcuts";
import "./keyboard-demos.css";

/** Launches the shared command palette with the lab's registered actions. */
export function CommandPaletteDemo() {
  const { showPalette } = useCommandPalette();
  return (
    <section class="properties lab-panel" aria-label="Command palette examples">
      <div class="eyebrow">COMMAND PALETTE</div>
      <h2>Find an action. Keep moving.</h2>
      <p class="field-help">
        Search for a component to open its panel, or change the lab's density
        and accent. All commands act on this workspace.
      </p>
      <div class="property-section button-samples">
        <Button variant="primary" onClick={showPalette}>
          <MagnifyingGlassIcon size={16} />
          Open command palette
        </Button>
        <ShortcutKeys shortcut="$mod+Shift+P" />
      </div>
      <div class="property-section">
        <div class="section-label">Try a search</div>
        <p class="field-help">
          Type “input forms”, “shortcuts”, or “accent”. Use the arrow keys to
          choose a result, Enter to run it, and Escape to dismiss.
        </p>
      </div>
    </section>
  );
}

/** Lists live shortcut registrations and provides an editable target for trying their focus behavior. */
export function ShortcutsDemo(props: { compact: boolean; accentName: string }) {
  const [note, setNote] = createSignal("");
  /** Lists global bindings independently of transient grid and editor shortcuts. */
  const labShortcuts = createMemo(() =>
    allShortcuts().filter((shortcut) => !shortcut.componentId),
  );
  return (
    <section class="properties lab-panel" aria-label="Shortcut examples">
      <div class="eyebrow">KEYBOARD SHORTCUTS</div>
      <h2>Keep your hands on the keys.</h2>
      <p class="field-help">
        These shortcuts are active throughout the lab. Density and accent
        actions pause while typing; the command palette shortcut works from an
        input too.
      </p>
      <dl class="lab-shortcut-list">
        <For each={labShortcuts()}>
          {(shortcut) => (
            <div>
              <dt>{shortcut.description}</dt>
              <dd>
                <ShortcutKeys shortcut={shortcut.key} />
              </dd>
            </div>
          )}
        </For>
      </dl>
      <p class="field-help" role="status">
        {props.compact ? "Compact" : "Comfort"} density · {props.accentName}{" "}
        accent
      </p>
      <label class="demo-input-label">
        Typing practice
        <Input
          density="comfortable"
          type="text"
          placeholder="Try the palette shortcut from here"
          value={note()}
          onInput={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <div class="property-section">
        <div class="section-label">Inside the command palette</div>
        <dl class="lab-shortcut-list">
          <div>
            <dt>Move between results</dt>
            <dd>
              <ShortcutKeys shortcut="↑ / ↓" />
            </dd>
          </div>
          <div>
            <dt>Run the selected command</dt>
            <dd>
              <ShortcutKeys shortcut="Enter" />
            </dd>
          </div>
          <div>
            <dt>Dismiss the palette</dt>
            <dd>
              <ShortcutKeys shortcut="Escape" />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
