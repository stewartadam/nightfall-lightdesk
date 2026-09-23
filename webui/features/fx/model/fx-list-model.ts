// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CubeIcon } from "@squidlab/phosphor-solid/cube";
import { ListDashesIcon } from "@squidlab/phosphor-solid/list-dashes";
import { SparkleIcon } from "@squidlab/phosphor-solid/sparkle";
import type { AppIcon } from "../../../components/ui/icon";
import type * as types from "../../../types";

export type FxListEntryType = "regular" | "step" | "module";

export interface FxListEntry {
  identifiers: types.Identifiers;
  type: FxListEntryType;
  typeLabel: string;
  typeIcon: AppIcon;
  detail: string;
  canEdit: boolean;
  canDelete: boolean;
}

/** Builds the initial spatial selection for module FX created from the UI. */
export function defaultSpatialSelection(): types.SpatialSelection {
  return { source: { type: "Fixture", data: { fixture_id: 1 } }, clauses: [] };
}

/** Formats module configuration entries into editable key=value lines. */
export function formatConfigText(config: Record<string, string>): string {
  return Object.entries(config)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Parses key=value configuration lines from the module FX editor. */
export function parseConfigText(text: string): Record<string, string> | string {
  const config: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const splitIndex = line.indexOf("=");
    if (splitIndex <= 0) {
      return `Config line ${index + 1} must use key=value.`;
    }
    const key = line.slice(0, splitIndex).trim();
    const value = line.slice(splitIndex + 1).trim();
    if (!key) {
      return `Config line ${index + 1} is missing a key.`;
    }
    config[key] = value;
  }
  return config;
}

/** Computes the next unused FX id across all FX entry types. */
export function nextFxId(entries: readonly FxListEntry[]): number {
  const existingIds = new Set(entries.map((entry) => entry.identifiers.id));
  let id = 1;
  while (existingIds.has(id)) id++;
  return id;
}

/** Derives a readable default label from a module name. */
export function defaultModuleLabel(moduleName: string): string {
  return moduleName || "Module FX";
}

/** Projects a regular FX record into the shared list-row shape. */
export function createRegularFxListEntry(fxEntry: types.Fx): FxListEntry {
  const attributeCount = Object.keys(fxEntry.attributes).length;
  return {
    identifiers: fxEntry.identifiers,
    type: "regular",
    typeLabel: "Regular",
    typeIcon: SparkleIcon,
    detail: `${attributeCount} attribute${attributeCount === 1 ? "" : "s"}`,
    canEdit: true,
    canDelete: true,
  };
}

/** Projects a step FX record into the shared list-row shape. */
export function createStepFxListEntry(fxEntry: types.StepFx): FxListEntry {
  const laneCount = fxEntry.lanes.length + (fxEntry.color_lane ? 1 : 0);
  return {
    identifiers: fxEntry.identifiers,
    type: "step",
    typeLabel: "Step",
    typeIcon: ListDashesIcon,
    detail: `${laneCount} lane${laneCount === 1 ? "" : "s"}`,
    canEdit: true,
    canDelete: true,
  };
}

/** Projects a stored module FX record into the shared list-row shape. */
export function createModuleFxListEntry(
  fxEntry: types.StoredFxModule,
): FxListEntry {
  return {
    identifiers: fxEntry.identifiers,
    type: "module",
    typeLabel: "Module",
    typeIcon: CubeIcon,
    detail: fxEntry.module_name,
    canEdit: false,
    canDelete: true,
  };
}
