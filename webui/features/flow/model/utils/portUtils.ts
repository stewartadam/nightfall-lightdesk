// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Port utility functions for flow editor components.
 * Provides port type labels, colors, and handle ID management.
 */

import type { FlowPortId, FlowPortType } from "../../../../types/index";

/**
 * Port type display labels
 */
const PORT_TYPE_LABELS: Record<FlowPortType, string> = {
  number: "Number",
  int: "Int",
  bool: "Bool",
  color: "Color",
  selection: "Selection",
  attribute: "Attribute",
  waveform: "Waveform",
  waveform_kind: "Waveform Kind",
  layer: "Layer",
  trigger: "Trigger",
  string: "String",
};

/**
 * Port type colors (hex)
 */
const PORT_TYPE_COLORS: Record<FlowPortType, string> = {
  number: "#38bdf8",
  int: "#38bdf8",
  bool: "#f59e0b",
  color: "#fb7185",
  selection: "#34d399",
  attribute: "#a3e635",
  waveform: "#818cf8",
  waveform_kind: "#a78bfa",
  layer: "#22d3ee",
  trigger: "#fb923c",
  string: "#e879f9",
};

/**
 * Get the display label for a port type.
 */
export function portTypeLabel(portType: FlowPortType | undefined): string {
  if (!portType) return "unknown";
  return PORT_TYPE_LABELS[portType] ?? "unknown";
}

/**
 * Get the hex color for a port type.
 */
export function portColorHex(portType: FlowPortType | undefined): string {
  if (!portType) return "#808080";
  return PORT_TYPE_COLORS[portType] ?? "#808080";
}

/**
 * Generate a handle ID for a port.
 */
export function portHandleId(portId: FlowPortId | undefined): string {
  return `port-${portId ?? "unknown"}`;
}

/**
 * Parse a port ID from a handle ID string.
 * Returns null if the handle ID is invalid.
 */
export function parsePortHandleId(handleId?: string | null): FlowPortId | null {
  if (!handleId) return null;
  const match = handleId.match(/^port-(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "", 10);
}
