// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { VerticalRangeSlider } from "../components/ui/vertical-range-slider";
import { Button } from "../components/ui/visual-language/button";
import AttributeSlider, {
  type AttributeMode,
} from "../components/widgets/attribute-slider";
import "./widget-demos.css";

/** Demonstrates independent transport enablement and both disabled switch states using local data. */
export function SwitchDemo() {
  const [input, setInput] = createSignal(true);
  const [output, setOutput] = createSignal(false);
  return (
    <section class="properties lab-panel" aria-label="Switch examples">
      <div class="eyebrow">TOGGLE SWITCHES</div>
      <h2>Independent inputs and outputs.</h2>
      <p class="field-help">
        Enable each direction independently. Tab to a switch and press Space to
        toggle it.
      </p>
      <div class="widget-sample-card">
        <div class="section-label">Art-Net · Preview</div>
        <div class="widget-switch-row">
          <ToggleSwitch
            label="Input"
            ariaLabel="Art-Net input"
            checked={input()}
            onChange={setInput}
          />
          <ToggleSwitch
            label="Output"
            ariaLabel="Art-Net output"
            checked={output()}
            onChange={setOutput}
          />
        </div>
        <p class="field-help" role="status">
          Input {input() ? "on" : "off"} · Output {output() ? "on" : "off"}
        </p>
      </div>
      <div class="widget-sample-card">
        <div class="section-label">Unavailable controls</div>
        <div class="widget-switch-row">
          <ToggleSwitch
            label="Input"
            ariaLabel="Unavailable input"
            checked
            disabled
            onChange={() => undefined}
          />
          <ToggleSwitch
            label="Output"
            ariaLabel="Unavailable output"
            checked={false}
            disabled
            onChange={() => undefined}
          />
        </div>
        <p class="field-help">
          Disabled controls retain their on or off state.
        </p>
      </div>
    </section>
  );
}

/** Presents live vertical faders, an external reset, reference ticks, and an initially disabled fader. */
export function FaderDemo() {
  const [intensity, setIntensity] = createSignal(65);
  const [speed, setSpeed] = createSignal(100);
  const [disabled, setDisabled] = createSignal(false);
  return (
    <section class="properties lab-panel" aria-label="Fader examples">
      <div class="eyebrow">VERTICAL FADERS</div>
      <h2>Levels at a glance.</h2>
      <div class="widget-fader-bank">
        <div class="widget-fader">
          <span>Intensity</span>
          <span class="muted">100%</span>
          <VerticalRangeSlider
            value={intensity()}
            onChange={setIntensity}
            markerValue={75}
            disabled={disabled()}
            ariaLabel="Preview intensity"
            height={160}
          />
          <span class="muted">0%</span>
          <output aria-label="Intensity readout">{intensity()}%</output>
        </div>
        <div class="widget-fader">
          <span>Speed</span>
          <span class="muted">200%</span>
          <VerticalRangeSlider
            value={speed()}
            onChange={setSpeed}
            max={200}
            step={5}
            markerValue={100}
            disabled={disabled()}
            ariaLabel="Preview speed"
            height={160}
          />
          <span class="muted">0%</span>
          <output aria-label="Speed readout">{speed()}%</output>
        </div>
        <div class="widget-fader">
          <span>Locked</span>
          <span class="muted">100%</span>
          <VerticalRangeSlider
            value={40}
            onChange={() => undefined}
            disabled
            ariaLabel="Locked level"
            height={160}
          />
          <span class="muted">0%</span>
          <output>40%</output>
        </div>
      </div>
      <div class="widget-switch-row">
        <ToggleSwitch
          label="Lock faders"
          ariaLabel="Lock preview faders"
          checked={disabled()}
          onChange={setDisabled}
        />
        <Button
          onClick={() => {
            setIntensity(65);
            setSpeed(100);
          }}
        >
          Reset levels
        </Button>
      </div>
      <p class="field-help">
        Drag or use arrow keys, Home, and End. Red marks indicate the reference
        level.
      </p>
    </section>
  );
}

/** Demonstrates absolute and relative attribute values with linked slider and numeric entry. */
export function AttributeDemo() {
  const [mode, setMode] = createSignal<AttributeMode>("absolute");
  const [value, setValue] = createSignal(128);
  const [committed, setCommitted] = createSignal(128);
  return (
    <section
      class="properties lab-panel"
      aria-label="Attribute slider examples"
    >
      <div class="eyebrow">ATTRIBUTE SLIDERS</div>
      <h2>A value or an adjustment.</h2>
      <div class="widget-sample-card">
        <AttributeSlider
          label="Dimmer"
          mode={mode()}
          value={value()}
          min={mode() === "relative" ? -255 : 0}
          max={255}
          onModeChange={setMode}
          onValueChange={setValue}
          onCommit={setCommitted}
        />
        <p class="field-help">
          {mode() === "absolute"
            ? "Absolute · 0 to 255"
            : "Relative · −255 to +255"}
        </p>
      </div>
      <p class="field-help" role="status">
        Current value: {value()} · Last committed value: {committed()}
      </p>
      <p class="field-help">
        Use Rel for signed adjustments. Switching to Abs clamps negative values
        to zero.
      </p>
    </section>
  );
}
