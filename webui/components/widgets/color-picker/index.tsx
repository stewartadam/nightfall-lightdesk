// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../../ui/segmented-control";
import { SegmentedTabs } from "../../ui/segmented-tabs";
import {
  type ColorPickerValue,
  colorPickerValue,
  colorStringToHsv,
  type HsvColor,
  hsvColorsEqual,
  hsvToRgb,
  rgbToHex,
} from "./model";

export type { ColorPickerValue, HsvColor } from "./model";

export interface ColorPickerProps {
  value: HsvColor;
  onChange: (value: ColorPickerValue) => void;
  presets?: string[];
  class?: string;
}

const log = getLogger(import.meta.url);

const MODE_OPTIONS: readonly SegmentedControlOption<"square" | "circle">[] = [
  { value: "square", label: "Square" },
  { value: "circle", label: "Circle" },
];

/** Edits controlled HSV colors through a spectrum canvas, brightness slider, and preset swatches. */
export default function ColorPicker(props: ColorPickerProps) {
  /* -------------------- state -------------------- */
  const [draft, setDraft] = createSignal<HsvColor>(props.value);
  const [mode, setMode] = createSignal<"square" | "circle">("square");
  const [readout, setReadout] = createSignal<"rgb" | "hsv">("rgb");
  const tabsId = createUniqueId();
  const rgbTabId = `${tabsId}-rgb`;
  const hsvTabId = `${tabsId}-hsv`;
  const rgbPanelId = `${tabsId}-panel-rgb`;
  const hsvPanelId = `${tabsId}-panel-hsv`;

  onMount(() => {
    log.trace("mounting");
  });

  onCleanup(() => {
    log.trace("unmounting");
  });

  /* -------------------- refs -------------------- */
  let canvas!: HTMLCanvasElement;

  /** Updates the local interaction draft and publishes the controlled value. */
  const changeDraft = (value: HsvColor) => {
    setDraft(value);
    props.onChange(colorPickerValue(value));
  };

  /* -------------------- drawing -------------------- */
  const drawSquare = () => {
    // Square HSV plane: X = Hue, Y = Saturation. Value comes from slider (v())
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    const img = ctx.createImageData(width, height);
    const data = img.data;
    const val = draft().v;
    for (let y = 0; y < height; y++) {
      const sat = 1 - y / height;
      for (let x = 0; x < width; x++) {
        const hue = (x / width) * 360;
        const [r, g, b] = hsvToRgb({ h: hue, s: sat, v: val });
        const idx = (y * width + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const drawCircle = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    const radius = Math.min(width, height) / 2;
    const cx = width / 2;
    const cy = height / 2;
    const img = ctx.createImageData(width, height);
    const data = img.data;
    const val = draft().v;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * width + x) * 4;
        if (dist > radius) {
          data[idx + 3] = 0;
          continue;
        }
        const sat = dist / radius;
        let hue = (Math.atan2(dy, dx) * 180) / Math.PI;
        hue = (hue + 360) % 360;
        const [r, g, b] = hsvToRgb({ h: hue, s: sat, v: val });
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const redraw = () => (mode() === "square" ? drawSquare() : drawCircle());

  createEffect(() => {
    mode();
    draft();
    redraw();
  });

  /** Synchronizes the local interaction draft when the controlled value changes. */
  createEffect(() => {
    const value = props.value;
    if (!hsvColorsEqual(value, draft())) setDraft(value);
  });

  /* -------------------- pointer -------------------- */
  const getCanvasPoint = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x: Math.min(Math.max(x, 0), rect.width),
      y: Math.min(Math.max(y, 0), rect.height),
      width: rect.width,
      height: rect.height,
    };
  };

  const pointerMove = (e: PointerEvent) => {
    const { x, y, width, height } = getCanvasPoint(e);
    if (mode() === "square") {
      const hue = (x / width) * 360;
      const sat = 1 - y / height;
      changeDraft({ ...draft(), h: hue, s: sat });
    } else {
      const radius = Math.min(width, height) / 2;
      const cx = width / 2;
      const cy = height / 2;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
      const sat = dist / radius;
      let hue = (Math.atan2(dy, dx) * 180) / Math.PI;
      hue = (hue + 360) % 360;
      changeDraft({ ...draft(), h: hue, s: sat });
    }
  };

  const pointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    pointerMove(e);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
  };

  const pointerUp = () => {
    window.removeEventListener("pointermove", pointerMove);
    window.removeEventListener("pointerup", pointerUp);
  };

  /* -------------------- presets -------------------- */
  const presets = props.presets ?? [
    "#ff0000",
    "#ff7f00",
    "#ffff00",
    "#00ff00",
    "#00ffff",
    "#0000ff",
    "#8b00ff",
    "#ffffff",
    "#000000",
  ];

  const choosePreset = (hex: string) => {
    changeDraft(colorStringToHsv(hex));
  };

  /* -------------------- render -------------------- */
  /** In both modes the slider controls Value (brightness) */
  const sliderValue = () => draft().v;

  const sliderChange = (value: number) => changeDraft({ ...draft(), v: value });

  return (
    <div class={`flex flex-col gap-4 nodrag nopan ${props.class ?? ""}`.trim()}>
      {/* Mode toggle */}
      <SegmentedControl
        class="mb-2 self-start"
        label="Picker shape"
        density="compact"
        options={MODE_OPTIONS}
        value={mode()}
        onChange={setMode}
      />

      <div class="flex flex-row gap-4">
        {/* Picker + controls */}
        <div class="flex flex-col items-start text-gray-500">
          <div class="relative">
            <canvas
              ref={canvas}
              width={256}
              height={192}
              class="cursor-crosshair border border-gray-500 touch-none nodrag nopan"
              on:pointerdown={pointerDown}
            />
          </div>
          {/* Slider */}
          <div class="mt-2 w-[256px] flex items-center gap-2">
            <div
              class="w-4 h-4 border border-gray-500"
              style={{ background: colorPickerValue(draft()).hex }}
            />
            <input
              type="range"
              aria-label="Color brightness"
              min="0"
              max="100"
              step="1"
              value={Math.round(sliderValue() * 100)}
              onInput={(e) =>
                sliderChange(
                  Number.parseInt(
                    (e.currentTarget as HTMLInputElement).value,
                    10,
                  ) / 100,
                )
              }
              class="w-full h-2 appearance-none rounded-full cursor-pointer nodrag nopan"
              style={{
                background: `linear-gradient(to right, #000000, ${rgbToHex(...hsvToRgb({ ...draft(), v: 1 }))})`,
              }}
            />
          </div>
          {/* Readout */}
          <div class="mt-2 w-[256px] text-xs select-text">
            <SegmentedTabs
              id={tabsId}
              label="Color readout"
              contentId={readout() === "rgb" ? rgbPanelId : hsvPanelId}
              options={[
                { key: "rgb", label: "RGB", contentId: rgbPanelId },
                { key: "hsv", label: "HSV", contentId: hsvPanelId },
              ]}
              value={readout()}
              onChange={setReadout}
            />
            <div class="mt-1 font-mono">
              <div
                id={rgbPanelId}
                role="tabpanel"
                aria-labelledby={rgbTabId}
                hidden={readout() !== "rgb"}
              >
                {(() => {
                  const [r, g, b] = hsvToRgb(draft());
                  const hex = rgbToHex(r, g, b);
                  return (
                    <div class="flex flex-col gap-1">
                      <div class="flex flex-wrap gap-4">
                        <span>{`R ${r}`}</span>
                        <span>{`G ${g}`}</span>
                        <span>{`B ${b}`}</span>
                      </div>
                      <div class="select-text">Hex {hex}</div>
                    </div>
                  );
                })()}
              </div>
              <div
                id={hsvPanelId}
                role="tabpanel"
                aria-labelledby={hsvTabId}
                hidden={readout() !== "hsv"}
              >
                <div class="flex flex-wrap gap-4">
                  <span>{`H ${draft().h.toFixed(1)}`}</span>
                  <span>{`S ${(draft().s * 100).toFixed(1)}%`}</span>
                  <span>{`V ${(draft().v * 100).toFixed(1)}%`}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Presets */}
        <div
          class="grid grid-cols-2 gap-2 content-start"
          role="group"
          aria-label="Color presets"
        >
          {presets.map((hex) => (
            <button
              type="button"
              aria-label={`Choose ${hex.toUpperCase()}`}
              class="w-8 h-8 border border-gray-600 nodrag nopan"
              style={{ background: hex }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={() => choosePreset(hex)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
