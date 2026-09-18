// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Color from "colorjs.io";

export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export interface ColorPickerValue extends HsvColor {
  hex: string;
}

/** Converts normalized HSV channels into integer sRGB channels. */
export function hsvToRgb({ h, s, v }: HsvColor): [number, number, number] {
  const color = new Color("hsv", [h, s * 100, v * 100]).to("srgb");
  const [r, g, b] = color.coords;
  return [r, g, b].map((channel) => Math.round((channel ?? 0) * 255)) as [
    number,
    number,
    number,
  ];
}

/** Formats integer sRGB channels as an uppercase six-digit hex color. */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${[r, g, b].map(toHex).join("").toUpperCase()}`;
}

/** Converts a CSS color string into normalized HSV channels. */
export function colorStringToHsv(value: string): HsvColor {
  const color = new Color(value).to("hsv");
  const [h, s, v] = color.coords;
  return { h: h ?? 0, s: (s ?? 0) / 100, v: (v ?? 0) / 100 };
}

/** Adds the derived display hex string to a normalized HSV value. */
export function colorPickerValue(value: HsvColor): ColorPickerValue {
  return { ...value, hex: rgbToHex(...hsvToRgb(value)) };
}

/** Compares normalized HSV values without considering object identity. */
export function hsvColorsEqual(left: HsvColor, right: HsvColor): boolean {
  return left.h === right.h && left.s === right.s && left.v === right.v;
}
