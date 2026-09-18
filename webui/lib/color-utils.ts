// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Centralized color utility functions for the application.
 * Handles color parsing, formatting, and conversion across all components.
 */

import type { FlowColor } from "../types/index";

/**
 * RGB color representation (0-255 range).
 */
export type RGB = {
  r: number;
  g: number;
  b: number;
};

/**
 * HSV color representation.
 */
export type HSV = {
  h: number;
  s: number;
  v: number;
};

/**
 * Parse a hex color string to RGB values (0-255).
 * Supports both 3-character (#RGB) and 6-character (#RRGGBB) formats.
 * Returns null if the input is invalid, or a default red color if empty.
 */
export function parseHexColor(hex: string): RGB {
  if (!hex) return { r: 255, g: 0, b: 0 };
  const normalized = hex.trim().replace("#", "");

  if (normalized.length === 3) {
    const r = Number.parseInt(normalized[0] + normalized[0], 16);
    const g = Number.parseInt(normalized[1] + normalized[1], 16);
    const b = Number.parseInt(normalized[2] + normalized[2], 16);
    if ([r, g, b].some((value) => Number.isNaN(value))) {
      return { r: 255, g: 0, b: 0 };
    }
    return { r, g, b };
  }

  if (normalized.length === 6) {
    const r = Number.parseInt(normalized.slice(0, 2), 16);
    const g = Number.parseInt(normalized.slice(2, 4), 16);
    const b = Number.parseInt(normalized.slice(4, 6), 16);
    if ([r, g, b].some((value) => Number.isNaN(value))) {
      return { r: 255, g: 0, b: 0 };
    }
    return { r, g, b };
  }

  return { r: 255, g: 0, b: 0 };
}

/**
 * Convert a single number (0-255) to a 2-character hex string.
 */
export function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/**
 * Format a FlowColor (0-1 range) as a hex color string.
 * Returns #FF0000 (red) if no color is provided.
 */
export function formatColorHex(color?: FlowColor | null): string {
  if (!color) return "#FF0000";
  return `#${toHex(color.r * 255)}${toHex(color.g * 255)}${toHex(color.b * 255)}`;
}

/**
 * Convert an attribute label to an HSV color.
 * Used for color picker initial state.
 */
export function attributeLabelToHsv(label: string): HSV {
  const normalized = label.trim().toLowerCase();
  if (normalized === "green") return { h: 120, s: 1, v: 1 };
  if (normalized === "blue") return { h: 240, s: 1, v: 1 };
  return { h: 0, s: 1, v: 1 }; // Default to red
}

/**
 * Determine the dominant color channel and return the corresponding attribute label.
 */
export function rgbToAttributeLabel(rgb: RGB): string {
  if (rgb.r >= rgb.g && rgb.r >= rgb.b) return "Red";
  if (rgb.g >= rgb.r && rgb.g >= rgb.b) return "Green";
  return "Blue";
}
