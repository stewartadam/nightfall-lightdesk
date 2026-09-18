// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Port value resolver functions.
 * Extracts typed values from port definitions with sensible defaults.
 */

import { type SpatialSelection, WaveformKind } from "../../../../types";
import type { FlowPortDefinition, FlowWaveform } from "../../../../types/index";

/**
 * Resolve a number value from a port definition.
 * Handles both Number and Int types.
 */
export function resolveNumberValue(port: FlowPortDefinition): number {
  const value = port.default_value;
  if (!value) return 0;
  if (value.type === "Number") return value.data;
  if (value.type === "Int") return value.data;
  return 0;
}

/**
 * Resolve a boolean value from a port definition.
 */
export function resolveBoolValue(port: FlowPortDefinition): boolean {
  const value = port.default_value;
  if (value?.type === "Bool") return value.data;
  return false;
}

/**
 * Resolve a string value from a port definition.
 */
export function resolveStringValue(port: FlowPortDefinition): string {
  const value = port.default_value;
  if (value?.type === "String") return value.data;
  return "";
}

/**
 * Resolve an attribute value from a port definition.
 * Handles both single and multiple attribute labels.
 */
export function resolveAttributeValue(port: FlowPortDefinition): string {
  const value = port.default_value;
  if (!value) return "Red";
  if (value.type === "AttributeLabel") return value.data;
  if (value.type === "AttributeLabels") return value.data.join(", ");
  return "Red";
}

/**
 * Resolve a selection value from a port definition.
 * Returns null if no valid selection is found.
 */
export function resolveSelectionValue(
  port: FlowPortDefinition,
): SpatialSelection | null {
  const value = port.default_value;
  if (value?.type !== "Selection") return null;
  return value.data;
}

/**
 * Resolve a waveform value from a port definition.
 * Returns null if no valid waveform is found.
 */
export function resolveWaveformValue(
  port: FlowPortDefinition,
): FlowWaveform | null {
  const value = port.default_value;
  if (value?.type !== "Waveform") return null;
  return value.data;
}

/**
 * Default waveform configuration.
 */
export const DEFAULT_WAVEFORM: FlowWaveform = {
  kind: WaveformKind.Sin,
  rate_secs: 1,
  amplitude: 1,
  phase: 0,
  base: 0,
  duty_cycle: 1.0,
};
