// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal, createUniqueId, For } from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
  Radio,
  Textarea,
} from "../components/ui/form-controls";
import { NumericStepper } from "../components/ui/numeric-stepper";
import { SegmentedTabs } from "../components/ui/segmented-tabs";
import { Button } from "../components/ui/visual-language/button";
import { PrelineAdvancedSelect } from "../components/widgets/advanced-select";
import "./input-forms-demo.css";

const initialValues = {
  name: "Opening wash",
  fade: "2.5",
  intensity: "80",
  bpm: "120",
  notes: "Bring the front wash up before the first cue.",
  trigger: "manual",
  completion: "hold",
  tracking: "track",
  enabled: true,
};
const layouts = ["Standard", "Properties"] as const;
const numericFields = [
  { key: "intensity", label: "Intensity", unit: "%", min: 0, max: 100 },
  { key: "bpm", label: "BPM rate", unit: "BPM", min: 60, max: 240 },
] as const;
type NumericFieldKey = (typeof numericFields)[number]["key"];

/** Accepts finite numeric drafts within the inclusive limits while rejecting empty fields. */
function isNumberInRange(value: string, min: number, max: number): boolean {
  return (
    value.trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) >= min &&
    Number(value) <= max
  );
}

/** Demonstrates editable form controls, validation, and local save/reset feedback. */
export function InputFormsDemo() {
  const id = createUniqueId();
  const [layout, setLayout] =
    createSignal<(typeof layouts)[number]>("Standard");
  const [values, setValues] = createSignal({ ...initialValues });
  const [submitted, setSubmitted] = createSignal(false);
  const [notice, setNotice] = createSignal("Changes stay in this sample form.");
  let nameInput!: HTMLInputElement;
  let fadeInput!: HTMLInputElement;
  const numericInputs: Partial<Record<NumericFieldKey, HTMLInputElement>> = {};

  /** Rejects blank names and numeric drafts outside each field's supported range. */
  const errors = createMemo(() => ({
    name: values().name.trim() ? "" : "Enter a cue name.",
    fade: isNumberInRange(values().fade, 0, 60)
      ? ""
      : "Enter a fade time between 0 and 60 seconds.",
    intensity: isNumberInRange(values().intensity, 0, 100)
      ? ""
      : "Enter an intensity between 0 and 100%.",
    bpm: isNumberInRange(values().bpm, 60, 240)
      ? ""
      : "Enter a rate between 60 and 240 BPM.",
  }));

  /** Updates one draft value and clears feedback from a previous save. */
  function update<K extends keyof typeof initialValues>(
    key: K,
    value: (typeof initialValues)[K],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    setNotice("Unsaved sample changes.");
  }

  /** Validates the draft, focuses the first error, and acknowledges a local save. */
  function save(event: SubmitEvent) {
    event.preventDefault();
    setSubmitted(true);
    const invalidNumber = numericFields.find((field) => errors()[field.key]);
    if (errors().name || errors().fade || invalidNumber) {
      setNotice("Check the highlighted fields.");
      if (errors().name) nameInput.focus();
      else if (errors().fade) fadeInput.focus();
      else if (invalidNumber) numericInputs[invalidNumber.key]?.focus();
      return;
    }
    setNotice(
      `Saved “${values().name.trim()}” · ${Number(values().fade)} s fade · ${values().enabled ? "Enabled" : "Disabled"}.`,
    );
  }

  /** Restores the initial draft and clears validation without reloading the panel. */
  function reset(event: Event) {
    event.preventDefault();
    setValues({ ...initialValues });
    setSubmitted(false);
    setNotice("Sample form reset.");
  }

  return (
    <section class="properties lab-panel" aria-label="Input form examples">
      <div class="eyebrow">INPUT FORMS</div>
      <h2>Details, ready to edit.</h2>
      <p class="field-help">
        A sample cue with labels, hints, and validation. Required fields are
        marked *.
      </p>
      <SegmentedTabs
        id={`${id}-tab`}
        label="Form layout"
        contentId={`${id}-panel`}
        options={layouts.map((key) => ({ key, label: key }))}
        value={layout()}
        onChange={setLayout}
      />
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${layout()}`}
      >
        <form
          class="input-form-demo"
          classList={{ "input-form-properties": layout() === "Properties" }}
          noValidate
          onSubmit={save}
          onReset={reset}
        >
          <div class="input-form-grid">
            <div class="input-form-field">
              <label for={`${id}-name`}>Cue name *</label>
              <Input
                density={layout() === "Properties" ? "compact" : undefined}
                ref={nameInput}
                id={`${id}-name`}
                type="text"
                required
                placeholder="Give this cue a name"
                value={values().name}
                onInput={(event) => update("name", event.currentTarget.value)}
                aria-invalid={submitted() && !!errors().name}
                aria-describedby={`${id}-name-help`}
              />
              <span
                id={`${id}-name-help`}
                classList={{
                  "input-form-error": submitted() && !!errors().name,
                }}
              >
                {submitted() && errors().name
                  ? errors().name
                  : "Shown in the cue list and playback controls."}
              </span>
            </div>
            <div class="input-form-field">
              <label for={`${id}-fade`}>
                {layout() === "Properties"
                  ? "Fade (s) *"
                  : "Fade time (seconds) *"}
              </label>
              <Input
                density={layout() === "Properties" ? "compact" : undefined}
                ref={fadeInput}
                id={`${id}-fade`}
                type="number"
                required
                min="0"
                max="60"
                step="any"
                value={values().fade}
                onInput={(event) => update("fade", event.currentTarget.value)}
                aria-invalid={submitted() && !!errors().fade}
                aria-describedby={`${id}-fade-help`}
              />
              <span
                id={`${id}-fade-help`}
                classList={{
                  "input-form-error": submitted() && !!errors().fade,
                }}
              >
                {submitted() && errors().fade
                  ? errors().fade
                  : "0–60 seconds. Use 0 for an instant change."}
              </span>
            </div>
            <For each={numericFields}>
              {(field) => (
                <div class="input-form-field">
                  <label for={`${id}-${field.key}`}>{field.label} *</label>
                  <NumericStepper
                    density={layout() === "Properties" ? "compact" : undefined}
                    ref={(element) => {
                      numericInputs[field.key] = element;
                    }}
                    id={`${id}-${field.key}`}
                    required
                    min={field.min}
                    max={field.max}
                    step="any"
                    value={values()[field.key]}
                    fallbackValue={Number(initialValues[field.key])}
                    onValueChange={(value) => update(field.key, value)}
                    decreaseLabel={`Decrease ${field.label.toLowerCase()}`}
                    increaseLabel={`Increase ${field.label.toLowerCase()}`}
                    unit={
                      <span id={`${id}-${field.key}-unit`}>{field.unit}</span>
                    }
                    aria-invalid={submitted() && !!errors()[field.key]}
                    aria-describedby={`${id}-${field.key}-unit ${id}-${field.key}-help`}
                  />
                  <span
                    id={`${id}-${field.key}-help`}
                    classList={{
                      "input-form-error": submitted() && !!errors()[field.key],
                    }}
                  >
                    {submitted() && errors()[field.key]
                      ? errors()[field.key]
                      : `${field.min}–${field.max} ${field.unit}. Buttons adjust by 1.`}
                  </span>
                </div>
              )}
            </For>
            <div class="input-form-field">
              <span>Trigger</span>
              <PrelineAdvancedSelect
                options={[
                  { value: "manual", label: "Manual" },
                  { value: "previous", label: "After previous" },
                  { value: "timecode", label: "Timecode" },
                ]}
                selectedValues={[values().trigger]}
                onSelectedValuesChange={(selected) =>
                  update("trigger", selected[0] ?? "manual")
                }
                ariaLabel="Cue trigger"
              />
            </div>
            <div class="input-form-field">
              <label for={`${id}-completion`}>On completion</label>
              <NativeSelect
                id={`${id}-completion`}
                density={layout() === "Properties" ? "compact" : undefined}
                value={values().completion}
                onChange={(event) =>
                  update("completion", event.currentTarget.value)
                }
              >
                <option value="hold">Hold final look</option>
                <option value="release">Release output</option>
              </NativeSelect>
            </div>
            <div class="input-form-field">
              <label for={`${id}-id`}>
                Cue ID<span class="input-form-state"> · Read only</span>
              </label>
              <Input
                density={layout() === "Properties" ? "compact" : undefined}
                id={`${id}-id`}
                value="CUE 042"
                readOnly
              />
            </div>
            <div class="input-form-field input-form-wide">
              <label for={`${id}-notes`}>Notes</label>
              <Textarea
                density={layout() === "Properties" ? "compact" : undefined}
                id={`${id}-notes`}
                rows={layout() === "Properties" ? 2 : 3}
                placeholder="Add an operator note"
                value={values().notes}
                onInput={(event) => update("notes", event.currentTarget.value)}
              />
            </div>
            <div class="input-form-field">
              <span id={`${id}-tracking-label`}>Tracking</span>
              <fieldset
                class="input-form-choices"
                aria-labelledby={`${id}-tracking-label`}
              >
                <label class="input-form-choice">
                  <Radio
                    name={`${id}-tracking`}
                    value="track"
                    checked={values().tracking === "track"}
                    onChange={() => update("tracking", "track")}
                  />
                  Track changes
                </label>
                <label class="input-form-choice">
                  <Radio
                    name={`${id}-tracking`}
                    value="cue"
                    checked={values().tracking === "cue"}
                    onChange={() => update("tracking", "cue")}
                  />
                  Cue only
                </label>
              </fieldset>
            </div>
            <div class="input-form-field">
              <span id={`${id}-availability-label`}>Availability</span>
              <fieldset
                class="input-form-choices"
                aria-labelledby={`${id}-availability-label`}
              >
                <label class="input-form-choice">
                  <Checkbox
                    checked={values().enabled}
                    onChange={(event) =>
                      update("enabled", event.currentTarget.checked)
                    }
                  />
                  Enable cue
                </label>
                <label class="input-form-choice">
                  <Checkbox disabled />
                  Send to live output · Unavailable
                </label>
              </fieldset>
            </div>
            <div class="input-form-field input-form-wide">
              <label for={`${id}-destination`}>
                {layout() === "Properties" ? "Output" : "Output destination"}
                <span class="input-form-state"> · Disabled</span>
              </label>
              <Input
                density={layout() === "Properties" ? "compact" : undefined}
                id={`${id}-destination`}
                type="text"
                value="Connect an output to configure"
                disabled
              />
            </div>
          </div>
          <div class="button-samples">
            <Button
              variant="primary"
              size={layout() === "Properties" ? "compact" : "standard"}
              type="submit"
            >
              Save sample
            </Button>
            <Button
              size={layout() === "Properties" ? "compact" : "standard"}
              type="reset"
            >
              Reset form
            </Button>
          </div>
          <p class="field-help" role="status">
            {notice()}
          </p>
        </form>
      </div>
    </section>
  );
}
