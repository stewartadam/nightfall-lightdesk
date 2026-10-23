// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { ArrowsLeftRightIcon } from "@squidlab/phosphor-solid/arrows-left-right";
import { ClockIcon } from "@squidlab/phosphor-solid/clock";
import { PianoKeysIcon } from "@squidlab/phosphor-solid/piano-keys";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { WaveformIcon } from "@squidlab/phosphor-solid/waveform";
import { createSignal } from "solid-js";
import { NativeSelect } from "../components/ui/form-controls";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../components/ui/segmented-control";
import { SettingsRow, SettingsSection } from "../components/ui/settings-row";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { Toolbar } from "../components/ui/toolbar";
import { ToggleToolbarButton } from "../components/ui/toolbar-button";
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
      <div class="widget-sample-card" data-testid="switch-layouts">
        <div class="section-label">Layouts</div>
        <div class="widget-switch-stack">
          <ToggleSwitch
            label="Switch right"
            ariaLabel="Switch right layout"
            checked={input()}
            onChange={setInput}
          />
          <ToggleSwitch
            label="Switch end"
            ariaLabel="Switch end layout"
            layout="switch-end"
            checked={input()}
            onChange={setInput}
          />
          <ToggleSwitch
            ariaLabel="Switch only layout"
            layout="switch-only"
            checked={input()}
            onChange={setInput}
          />
          <ToggleSwitch
            label="Switch left, as a section heading"
            ariaLabel="Switch left layout"
            layout="switch-left"
            labelClass="text-sm font-medium text-gray-300"
            checked={input()}
            onChange={setInput}
          />
          <p class="field-help nf-switch-label-inset">
            Content under a switch-left heading lines up with its label using
            nf-switch-label-inset.
          </p>
        </div>
      </div>
      <div class="widget-sample-card" data-testid="settings-rows">
        <SettingsSection title="Settings rows">
          <SettingsRow
            label="Settings row switch"
            description="Title and explanation on the left, control aligned to the right edge."
          >
            {(field) => (
              <ToggleSwitch
                id={field.id}
                describedBy={field.describedBy}
                ariaLabel="Settings row switch"
                layout="switch-only"
                checked={input()}
                onChange={setInput}
              />
            )}
          </SettingsRow>
          <SettingsRow
            label="Settings row select"
            description="Selects and fields size to their content."
          >
            {(field) => (
              <NativeSelect id={field.id} aria-describedby={field.describedBy}>
                <option>Until quit</option>
                <option>Per session</option>
              </NativeSelect>
            )}
          </SettingsRow>
          <SettingsRow
            label="Settings row action"
            description="Buttons keep their own name, so the title does not label them."
            labelControl={false}
          >
            {() => <Button size="compact">Manage</Button>}
          </SettingsRow>
        </SettingsSection>
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

const QUALITY_OPTIONS: readonly SegmentedControlOption<string>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const DIRECTION_OPTIONS: readonly SegmentedControlOption<string>[] = [
  {
    value: "reverse",
    icon: ArrowLeftIcon,
    ariaLabel: "Reverse",
    tooltip: "Reverse",
  },
  {
    value: "bounce",
    icon: ArrowsLeftRightIcon,
    ariaLabel: "Bounce",
    tooltip: "Bounce",
  },
  {
    value: "forward",
    icon: ArrowRightIcon,
    ariaLabel: "Forward",
    tooltip: "Forward",
  },
];

const SOURCE_OPTIONS: readonly SegmentedControlOption<string>[] = [
  { value: "internal", label: "Internal", icon: ClockIcon },
  { value: "midi", label: "MIDI", icon: PianoKeysIcon },
  {
    value: "ltc",
    label: "LTC",
    icon: WaveformIcon,
    disabled: true,
    tooltip: "No LTC input is connected",
  },
];

const UNIT_OPTIONS: readonly SegmentedControlOption<string>[] = [
  { value: "percent", label: "%", ariaLabel: "Percent" },
  { value: "degrees", label: "°", ariaLabel: "Degrees" },
];

/** Demonstrates radio-valued segmented controls in each density, with icons, disabled options and a toolbar. */
export function SegmentedControlDemo() {
  const [quality, setQuality] = createSignal("medium");
  const [direction, setDirection] = createSignal("forward");
  const [source, setSource] = createSignal("internal");
  const [unit, setUnit] = createSignal("percent");
  const [playing, setPlaying] = createSignal(false);
  return (
    <section
      class="properties lab-panel"
      aria-label="Segmented control examples"
    >
      <div class="eyebrow">SEGMENTED CONTROLS</div>
      <h2>One value from a few.</h2>
      <p class="field-help">
        Tab to the selected option, then use the arrow keys to move and select.
        Use segmented tabs instead when the choice switches content.
      </p>
      <div class="widget-sample-card">
        <div class="section-label">Comfortable · text</div>
        <SegmentedControl
          label="Beam quality"
          options={QUALITY_OPTIONS}
          value={quality()}
          onChange={setQuality}
        />
      </div>
      <div class="widget-sample-card">
        <div class="section-label">Icons, labels and a disabled option</div>
        <SegmentedControl
          label="Timecode source"
          options={SOURCE_OPTIONS}
          value={source()}
          onChange={setSource}
        />
      </div>
      <div class="widget-sample-card">
        <div class="section-label">Compact · icon only · in a toolbar</div>
        <Toolbar label="Effect playback" class="flex items-center gap-2">
          <SegmentedControl
            label="Effect direction"
            density="compact"
            options={DIRECTION_OPTIONS}
            value={direction()}
            onChange={setDirection}
          />
          <ToggleToolbarButton
            label={playing() ? "Stop preview" : "Preview"}
            pressed={playing()}
            onClick={() => setPlaying(!playing())}
          >
            <PlayIcon size={16} />
          </ToggleToolbarButton>
        </Toolbar>
      </div>
      <div class="widget-sample-card">
        <div class="section-label">Compact · fill</div>
        <SegmentedControl
          class="w-48"
          label="Position units"
          density="compact"
          fill
          options={UNIT_OPTIONS}
          value={unit()}
          onChange={setUnit}
        />
      </div>
      <p class="field-help" role="status">
        Quality {quality()} · Source {source()} · Direction {direction()} ·
        Units {unit()}
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
