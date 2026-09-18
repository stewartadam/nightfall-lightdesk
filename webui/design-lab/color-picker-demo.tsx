// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { Button } from "../components/ui/visual-language/button";
import ColorPicker from "../components/widgets/color-picker";
import {
  colorPickerValue,
  colorStringToHsv,
} from "../components/widgets/color-picker/model";
import "./color-picker-demo.css";

/** Presents the shared color picker with a local swatch that follows canvas, preset, and brightness edits. */
export function ColorPickerDemo() {
  const initialColor = colorPickerValue(colorStringToHsv("#54D5B4"));
  const [color, setColor] = createSignal(initialColor);

  return (
    <section class="properties lab-panel" aria-label="Color picker examples">
      <div class="eyebrow">COLOR PICKER</div>
      <h2>Explore hue, saturation, and brightness.</h2>
      <p class="field-help">
        Choose a preset or drag through the spectrum. Switch between square and
        circular views.
      </p>
      <div class="color-picker-demo-layout">
        <ColorPicker
          class="lab-color-picker"
          value={color()}
          onChange={setColor}
        />
        <div
          class="color-picker-demo-preview"
          role="group"
          aria-label="Selected color"
        >
          <div class="section-label">Selected color</div>
          <div
            class="color-picker-demo-swatch"
            role="img"
            aria-label={`Selected color ${color().hex}`}
            style={{ background: color().hex }}
          />
          <output aria-label="Selected hex color">{color().hex}</output>
          <p class="field-help">Local preview · no live output</p>
          <Button onClick={() => setColor(initialColor)}>Reset color</Button>
        </div>
      </div>
    </section>
  );
}
