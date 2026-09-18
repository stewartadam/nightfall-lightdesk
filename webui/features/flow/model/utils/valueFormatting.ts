// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Value formatting utilities for flow editor components.
 * Handles display formatting of FlowValue and node kind labels.
 */

import { toHex } from "../../../../lib/color-utils";
import { formatSpatialSelection } from "../../../../lib/wasm-bridge";
import { flowNodeTemplates } from "../../../../state/appStores";
import type { FlowValue } from "../../../../types/index";

/**
 * Format a node kind string into a human-readable label.
 * Looks up the authoritative label from flowNodeTemplates (populated from backend).
 * Returns a fallback label (formatted kind) if templates haven't loaded yet.
 */
export function formatNodeKindLabel(kind: string): string {
  const templates = flowNodeTemplates.get();
  const descriptor = templates.find((t) => t.kind === kind);

  if (!descriptor) {
    // Fallback to a formatted version of the kind during initial load
    // when templates may not have arrived yet from the backend
    return kind
      .split(/(?=[A-Z])/)
      .join(" ")
      .split("_")
      .join(" ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  return descriptor.label;
}

/**
 * Format a FlowValue for display.
 * Returns null for values that shouldn't be displayed (e.g., LayerSummary).
 */
function formatFlowValue(value: FlowValue): string | null {
  switch (value.type) {
    case "Number":
      return value.data.toFixed(2);
    case "Int":
      return `${value.data}`;
    case "Bool":
      return value.data ? "True" : "False";
    case "String":
      return value.data;
    case "Color": {
      const r = Math.round(value.data.r * 255);
      const g = Math.round(value.data.g * 255);
      const b = Math.round(value.data.b * 255);
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    case "Selection":
      return "Selection";
    case "AttributeLabel":
      return value.data;
    case "AttributeLabels":
      return value.data.join(", ");
    case "Waveform":
      return `${value.data.kind}`;
    case "WaveformKind":
      return value.data;
    case "LayerSummary":
      return null;
  }
}

/**
 * Format a flow value for UI labels that can wait on WASM-backed rendering.
 */
export async function formatFlowValueLabel(
  value: FlowValue,
): Promise<string | null> {
  if (value.type === "Selection") {
    return formatSpatialSelection(value.data).catch(() => "Selection");
  }
  return formatFlowValue(value);
}
