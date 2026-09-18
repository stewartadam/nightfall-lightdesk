// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CheckIcon } from "@squidlab/phosphor-solid/check";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { createSignal } from "solid-js";
import { RangeSlider } from "../components/ui/range-slider";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { Button } from "../components/ui/visual-language/button";
import {
  type TabAlignment,
  TabAlignmentSelect,
} from "../components/ui/visual-language/tab-alignment-select";
import { ButtonPopoverDemo } from "./button-popover-demo";

/** Demonstrates scalar and two-handle sliders with editable units, fractional steps, and disabled state. */
export function SliderDemo() {
  const [intensity, setIntensity] = createSignal<readonly [number, number]>([
    20, 80,
  ]);
  const [phase, setPhase] = createSignal<readonly [number, number]>([-90, 90]);
  const [amplitude, setAmplitude] = createSignal(65);
  const [disabled, setDisabled] = createSignal(false);
  return (
    <section class="properties lab-panel" aria-label="Slider examples">
      <div class="eyebrow">RANGE SLIDER</div>
      <h2>Precise by hand or by number.</h2>
      <div class="demo-fields">
        <div
          class="property-section"
          role="group"
          aria-label="Intensity range control"
        >
          <div class="section-label">Intensity range</div>
          <RangeSlider
            mode="range"
            value={intensity()}
            onChange={setIntensity}
            ariaLabel="Intensity"
            disabled={disabled()}
          />
          <p class="field-help">Two handles · 0–100% · 1% steps</p>
        </div>
        <div
          class="property-section"
          role="group"
          aria-label="Phase range control"
        >
          <div class="section-label">Phase spread</div>
          <RangeSlider
            mode="range"
            value={phase()}
            onChange={setPhase}
            min={-180}
            max={180}
            step={0.5}
            suffix="°"
            ariaLabel="Phase"
            disabled={disabled()}
          />
          <p class="field-help">Two handles · −180° to 180° · 0.5° steps</p>
        </div>
        <div class="property-section">
          <div class="section-label">Amplitude</div>
          <RangeSlider
            value={amplitude()}
            onChange={setAmplitude}
            ariaLabel="Amplitude"
            disabled={disabled()}
          />
          <p class="field-help">Single handle · the FX editor control</p>
        </div>
      </div>
      <ToggleSwitch
        label="Disable sliders"
        ariaLabel="Disable sliders"
        checked={disabled()}
        onChange={setDisabled}
      />
    </section>
  );
}

/** Displays shared button variants and a stateful toggle without touching show data. */
export function ButtonDemo() {
  const [enabled, setEnabled] = createSignal(false);
  const [notice, setNotice] = createSignal(
    "Choose an action to try its feedback.",
  );
  return (
    <section class="properties lab-panel" aria-label="Button examples">
      <div class="eyebrow">BUTTON</div>
      <h2>Actions with a clear hierarchy.</h2>
      <p class="field-help">
        Press and hold a button, or focus it and hold Space, to feel its pressed
        state.
      </p>
      <div class="property-section button-samples">
        <Button
          variant="primary"
          onClick={() => setNotice("Sample changes applied.")}
        >
          <CheckIcon size={16} />
          Apply
        </Button>
        <Button onClick={() => setNotice("Sample cue added.")}>
          <PlusIcon size={16} />
          Add cue
        </Button>
        <Button variant="subtle" onClick={() => setNotice("Sample reset.")}>
          Reset
        </Button>
        <Button variant="danger" onClick={() => setNotice("Sample removed.")}>
          Delete
        </Button>
      </div>
      <div class="property-section button-samples">
        <Button disabled>Unavailable</Button>
        <Button
          aria-pressed={enabled()}
          variant={enabled() ? "primary" : "secondary"}
          onClick={() => setEnabled(!enabled())}
        >
          Snap {enabled() ? "on" : "off"}
        </Button>
        <Button
          size="icon"
          aria-label="Add sample"
          onClick={() => setNotice("Icon action activated.")}
        >
          <PlusIcon size={16} />
        </Button>
      </div>
      <p class="field-help" role="status">
        {notice()}
      </p>
      <ButtonPopoverDemo />
    </section>
  );
}

/** Exposes live tab placement, alignment, and layout controls for the shared host. */
export function DockingDemo(props: {
  position: "top" | "bottom";
  onPosition: (position: "top" | "bottom") => void;
  alignment: TabAlignment;
  onAlignment: (alignment: TabAlignment) => void;
  onReset: () => void;
}) {
  return (
    <section class="properties lab-panel" aria-label="Docking examples">
      <div class="eyebrow">DOCKVIEW HOST</div>
      <h2>A workspace you can arrange.</h2>
      <p class="field-help">
        Drag tabs to reorder or split regions. Tab dragging uses smooth
        animation. Drag the grips to resize.
      </p>
      <div class="property-section">
        <div class="section-label">Tab position</div>
        <div class="segmented demo-toggle">
          <Button
            aria-label="Top tabs"
            aria-pressed={props.position === "top"}
            onClick={() => props.onPosition("top")}
          >
            Top
          </Button>
          <Button
            aria-label="Bottom tabs"
            aria-pressed={props.position === "bottom"}
            onClick={() => props.onPosition("bottom")}
          >
            Bottom
          </Button>
        </div>
      </div>
      <div class="property-section">
        <TabAlignmentSelect
          value={props.alignment}
          onChange={props.onAlignment}
        />
        <p class="field-help">
          Applies to regular and edge groups. Justify fills the tab strip.
        </p>
      </div>
      <div class="property-section">
        <Button onClick={props.onReset}>Restore workspace</Button>
        <p class="field-help">
          Restores the starting panels and resets their sample values. Closed
          demos can always be reopened from the index.
        </p>
      </div>
    </section>
  );
}
