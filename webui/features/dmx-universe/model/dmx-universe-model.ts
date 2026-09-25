// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FIXTURE_VALUE_TEXT_COLORS } from "../../../lib/datagrid";
import { CONSOLE_TRANSPORT } from "../../../lib/dmx-universe-data";
import { normalizeAttributeName } from "../../../lib/utils";
import type * as types from "../../../types";
import type { Attribute } from "../../../types";
export interface ChannelInfo {
  fixtureUid: string;
  fixtureId: number;
  fixtureLabel: string;
  elementIndex: number;
  elementLabel: string;
  attribute: string;
  attributeKey: string;
}

export interface FixtureJumpTarget {
  universeId: number;
  address: number;
  fixtureId: number;
  elementIndex?: number;
  attributeName?: string;
  attributeSearchText?: string;
  targetKind: "attribute" | "element" | "fixture";
}

export interface FixtureJumpQuery {
  fixtureIdText: string;
  elementIndex?: number;
  attributeQuery?: string;
}

export type DmxChannelValueTone = "asserted" | "default" | "input" | "manual";

export const DMX_CHANNEL_VALUE_TEXT_COLORS: Record<
  DmxChannelValueTone,
  string
> = {
  asserted: "#ffffff",
  default: "#6b7280",
  input: FIXTURE_VALUE_TEXT_COLORS.input,
  manual: FIXTURE_VALUE_TEXT_COLORS.manual,
};

/** Extract display name from Attribute discriminated union */
export function getAttributeName(attr: Attribute): string {
  if (attr.type === "Custom" && attr.data) {
    return attr.data.label;
  }
  return attr.type;
}

/** Calculate DMX channel width from resolution */
export function getChannelWidth(resolution: string): number {
  switch (resolution) {
    case "Coarse":
      return 1;
    case "Fine":
      return 2;
    case "UltraFine":
      return 3;
    case "Uber":
      return 4;
    default:
      return 1;
  }
}

/** Binding selection key for a displayed output numbering space. */
export type OutputSpaceSelection =
  | "sacn"
  | "artnet"
  | "udmx"
  | "disabled"
  | "console"
  | null;

/** Maps a displayed numbering-space label to its binding selection key. */
export function normalizeSelectedTransport(
  transport: string,
): OutputSpaceSelection {
  if (transport === CONSOLE_TRANSPORT) return "console";
  if (transport === "sACN") return "sacn";
  if (transport === "Art-Net") return "artnet";
  if (transport === "USB") return "udmx";
  if (transport === "Disabled") return "disabled";
  return null;
}

/**
 * Returns whether a patch location belongs to the selected numbering space. Console
 * selection matches console-space locations (`null` transport) only; transport
 * selections match wire locations of that transport family.
 */
export function outputTransportMatchesSelection(
  transport: types.OutputTransport | null,
  selection: OutputSpaceSelection,
): boolean {
  if (selection === null) return true;
  if (selection === "console") return transport === null;
  if (!transport) return false;
  if (selection === "sacn") return transport.type === "Sacn";
  if (selection === "artnet") return transport.type === "ArtNet";
  if (selection === "udmx") return transport.type === "Udmx";
  if (selection === "disabled") return transport.type === "Disabled";
  return false;
}

/** Normalizes typed and patched attribute names for case-insensitive matching. */
export function normalizeFixtureJumpAttributeSearch(value: string): string {
  return normalizeAttributeName(value).trim().toLocaleLowerCase();
}

/** Parses fixture jump text as fixture ID, optional element, and optional attribute. */
export function parseFixtureJumpQuery(
  query: string,
): FixtureJumpQuery | undefined {
  const match = query
    .trim()
    .match(/^(\d+)(?:\.(\d+))?(?:\s+(?:"([^"]+)"|(.+)))?$/);
  if (!match) return undefined;

  const [, fixtureIdText, elementText, quotedAttribute, bareAttribute] = match;
  const elementIndex =
    elementText === undefined ? undefined : Number.parseInt(elementText, 10);
  const attributeQuery = (quotedAttribute ?? bareAttribute)?.trim();
  return {
    fixtureIdText,
    ...(elementIndex !== undefined ? { elementIndex } : {}),
    ...(attributeQuery ? { attributeQuery } : {}),
  };
}
