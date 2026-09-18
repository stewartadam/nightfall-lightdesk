// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createSignal } from "solid-js";
import { DropdownMenu } from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/form-controls";
import { NumericStepper } from "../components/ui/numeric-stepper";
import "./button-popover-demo.css";

/** Demonstrates the timeline's inline content dropdown with locally editable tempo settings. */
export function ButtonPopoverDemo() {
  const [bpm, setBpm] = createSignal(120);
  const [bpmDraft, setBpmDraft] = createSignal("120");
  const [beatsPerBar, setBeatsPerBar] = createSignal(4);
  const [isOpen, setIsOpen] = createSignal(false);

  return (
    <div class="property-section">
      <div class="section-label">Inline popover</div>
      <p class="field-help button-popover-help">
        Adjust a value without leaving the panel.
      </p>
      <DropdownMenu
        placement="below"
        triggerClass={`nf-button ${isOpen() ? "primary" : ""}`}
        triggerLabel="Tempo controls"
        onOpenChange={setIsOpen}
        trigger={
          <>
            <span>{bpm()} BPM</span>
            <CaretDownIcon size={14} aria-hidden="true" />
          </>
        }
      >
        <div
          class="button-popover-content"
          role="group"
          aria-label="Tempo settings"
        >
          <div class="section-label">Tempo</div>
          <div class="button-popover-field">
            <label for="sample-popover-bpm">BPM rate</label>
            <NumericStepper
              density="compact"
              id="sample-popover-bpm"
              class="flex-1"
              min={60}
              max={240}
              step={1}
              required
              value={bpmDraft()}
              fallbackValue={bpm()}
              decreaseLabel="Decrease sample BPM"
              increaseLabel="Increase sample BPM"
              onValueChange={(value) => {
                setBpmDraft(value);
                const next = Number(value);
                if (
                  value.trim() &&
                  Number.isInteger(next) &&
                  next >= 60 &&
                  next <= 240
                )
                  setBpm(next);
              }}
              onBlur={() => setBpmDraft(String(bpm()))}
            />
          </div>
          <label class="button-popover-field">
            <span>Beats per bar</span>
            <Input
              density="compact"
              type="number"
              min="2"
              max="12"
              step="1"
              value={beatsPerBar()}
              onChange={(event) => {
                if (event.currentTarget.checkValidity())
                  setBeatsPerBar(event.currentTarget.valueAsNumber);
                else event.currentTarget.value = String(beatsPerBar());
              }}
              required
            />
          </label>
          <p class="field-help">Changes apply to this preview.</p>
        </div>
      </DropdownMenu>
    </div>
  );
}
