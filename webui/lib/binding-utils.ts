// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import { fixtureWireLayout } from "./dmx";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
} from "./network-dmx-output-targets";

type FixturePatchEntry = {
  universe: number;
  /** Address of the element's first patched byte. */
  address: number;
  /** Byte addresses per element parameter index, most significant first; empty when unpatched. */
  parameterAddresses: number[][];
  transport?: types.OutputTransport;
};

export type FixturePatchMap = Record<
  string,
  Record<string, Array<FixturePatchEntry>>
>;

const DEFAULT_UNIVERSE = 1;
const DEFAULT_ADDRESS = 1;

/**
 * Formats UUID bytes as lowercase hexadecimal without separators.
 */
function uuidBytesToHex(bytes: number[]): string {
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function normalizeFixtureUid(uid: unknown): string {
  if (typeof uid === "string") {
    return uid.replace(/-/g, "");
  }

  if (uid instanceof Uint8Array) {
    return uuidBytesToHex(Array.from(uid));
  }

  if (Array.isArray(uid)) {
    return uuidBytesToHex(uid as number[]);
  }

  if (uid && typeof uid === "object") {
    const record = uid as Record<string, number>;
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (numericKeys.length > 0) {
      numericKeys.sort((a, b) => Number(a) - Number(b));
      const bytes = numericKeys.map((key) => Number(record[key]));
      return uuidBytesToHex(bytes);
    }
  }

  return String(uid);
}

function normalizeFixtureUids(uids: unknown[]): string[] {
  return uids.map((uid) => normalizeFixtureUid(uid));
}

function normalizeParamName(value: string): string {
  return value.trim().toLowerCase();
}

function attributeName(attribute: types.Attribute): string {
  if (attribute.type === "Custom") {
    return attribute.data.label;
  }
  return attribute.type;
}

function expandRange(range?: types.DmxRange): number[] {
  if (!range) return [];
  const start = range.start;
  const end = range.end;
  if (end < start) {
    return [];
  }
  const values: number[] = [];
  for (let value = start; value <= end; value++) {
    values.push(value);
  }
  return values;
}

function mapUniverseByIndex(
  source: number[],
  target: number[],
  index: number,
): number {
  if (target.length === 0) {
    return source[index] ?? source[source.length - 1] ?? DEFAULT_UNIVERSE;
  }
  if (target.length === 1) {
    return target[0];
  }
  if (index < target.length) {
    return target[index];
  }
  return target[target.length - 1];
}

function outputTargetIdToTransport(
  target: string,
  networkDmxOutputs: types.NetworkDmxOutputTargets,
  usbDmxOutputs: types.UsbDmxOutputTargets,
): types.OutputTransport | null {
  return outputTransportForOutputTargetId(
    target,
    networkDmxOutputs,
    usbDmxOutputs,
  );
}

function rangesOverlap(
  source?: types.DmxRange,
  disabled?: types.DmxRange,
): boolean {
  if (!source || !disabled) return true;
  return source.start <= disabled.end && disabled.start <= source.end;
}

/** Fixtures, and the part of each fixture, patched by a fixture output source. */
type FixtureOutputSelection = {
  uids: unknown[];
  element?: number;
  param?: string;
  dmxBreak: number;
};

/**
 * Returns the fixture selection of a `Fixture` or `FixtureBreak` output source,
 * mirroring the engine's `OutputSource::fixture_selection`; `Fixture` sources
 * address the primary break 1. Console sources return null.
 */
function fixtureOutputSelection(
  source: types.OutputSource,
): FixtureOutputSelection | null {
  switch (source.type) {
    case "Fixture":
      return {
        uids: source.data.uids as unknown[],
        element: source.data.element,
        param: source.data.param,
        dmxBreak: 1,
      };
    case "FixtureBreak":
      return {
        uids: source.data.uids as unknown[],
        dmxBreak: source.data.dmx_break,
      };
    case "Console":
      return null;
  }
}

function outputSourceMatches(
  source: types.OutputSource,
  disabled: types.OutputSource,
): boolean {
  if (source.type === "FixtureBreak") {
    // A whole-fixture disable also silences the fixture's additional breaks.
    const disabledSelection = fixtureOutputSelection(disabled);
    if (
      !disabledSelection ||
      disabledSelection.element !== undefined ||
      disabledSelection.param !== undefined ||
      (disabled.type === "FixtureBreak" &&
        disabledSelection.dmxBreak !== source.data.dmx_break)
    ) {
      return false;
    }
    const disabledUids = new Set(normalizeFixtureUids(disabledSelection.uids));
    return normalizeFixtureUids(source.data.uids as unknown[]).some((uid) =>
      disabledUids.has(uid),
    );
  }
  if (source.type !== disabled.type) return false;

  if (source.type === "Fixture" && disabled.type === "Fixture") {
    const sourceData = source.data;
    const disabledData = disabled.data;
    const sourceUids = normalizeFixtureUids(sourceData.uids as unknown[]);
    const disabledUids = new Set(
      normalizeFixtureUids(disabledData.uids as unknown[]),
    );
    const uidMatch = sourceUids.some((uid) => disabledUids.has(uid));
    if (!uidMatch) return false;
    const elementMatch =
      disabledData.element === undefined ||
      sourceData.element === disabledData.element;
    const paramMatch =
      disabledData.param === undefined ||
      sourceData.param === disabledData.param;
    return elementMatch && paramMatch;
  }

  if (source.type === "Console" && disabled.type === "Console") {
    const sourceData = source.data;
    const disabledData = disabled.data;
    const universeMatch = rangesOverlap(
      sourceData.universe,
      disabledData.universe,
    );
    const addressMatch =
      disabledData.address === undefined ||
      sourceData.address === undefined ||
      sourceData.address === disabledData.address;
    return universeMatch && addressMatch;
  }

  return false;
}

export function buildFixturePatchMapFromBindings(
  snapshot: types.BindingsSnapshot,
  fixtures: Record<string, types.Fixture>,
  networkDmxOutputs: types.NetworkDmxOutputTargets = defaultNetworkDmxOutputs(),
  usbDmxOutputs: types.UsbDmxOutputTargets = defaultUsbDmxOutputs(),
): FixturePatchMap {
  const patchMap: FixturePatchMap = {};
  const disabledSources: types.OutputSource[] = [];
  for (const binding of snapshot.disabled) {
    if (binding.type === "Output") {
      disabledSources.push(binding.data.source);
    }
  }
  for (const binding of snapshot.output) {
    if (binding.target.type === "Disabled") {
      disabledSources.push(binding.source);
    }
  }

  for (const binding of snapshot.output) {
    if (binding.target.type !== "Transport") continue;
    const sourceData = fixtureOutputSelection(binding.source);
    if (!sourceData) continue;

    if (
      disabledSources.some((source) =>
        outputSourceMatches(binding.source, source),
      )
    ) {
      continue;
    }

    const targetData = binding.target.data;
    const baseUniverses = expandRange(targetData.universe);
    const universes =
      baseUniverses.length > 0 ? baseUniverses : [DEFAULT_UNIVERSE];
    const baseAddress = targetData.address ?? DEFAULT_ADDRESS;
    const outputTransport = outputTargetIdToTransport(
      targetData.target,
      networkDmxOutputs,
      usbDmxOutputs,
    );
    if (!outputTransport) continue;

    let runningAddress = baseAddress;
    let lastUniverse = universes[0] ?? DEFAULT_UNIVERSE;

    const sourceUids = normalizeFixtureUids(sourceData.uids);
    for (const [index, uid] of sourceUids.entries()) {
      const fixture = fixtures[uid];
      if (!fixture) continue;

      const targetUniverse = mapUniverseByIndex(universes, universes, index);
      if (targetUniverse !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = targetUniverse;
      }

      const paramFilter = sourceData.param
        ? normalizeParamName(sourceData.param)
        : undefined;
      const layout = fixtureWireLayout(fixture, {
        elementId: sourceData.element,
        dmxBreak: sourceData.dmxBreak,
        includeParameter: paramFilter
          ? (parameter) =>
              normalizeParamName(attributeName(parameter.attribute)) ===
              paramFilter
          : undefined,
      });
      if (layout.footprint === 0) continue;

      const fixtureAddress = binding.clone ? baseAddress : runningAddress;
      const entries = new Map<number, FixturePatchEntry>();
      for (const placed of layout.parameters) {
        const addresses = placed.slots.map((slot) => fixtureAddress + slot);
        let entry = entries.get(placed.elementIndex);
        if (!entry) {
          entry = {
            universe: targetUniverse,
            address: Number.POSITIVE_INFINITY,
            parameterAddresses: fixture.elements[
              placed.elementIndex
            ].parameters.map(() => []),
            transport: outputTransport,
          };
          entries.set(placed.elementIndex, entry);
        }
        entry.parameterAddresses[placed.parameterIndex] = addresses;
        entry.address = Math.min(entry.address, ...addresses);
      }

      for (const [elementIndex, entry] of entries) {
        patchMap[uid] ??= {};
        const elementId = String(elementIndex + 1);
        patchMap[uid][elementId] ??= [];
        patchMap[uid][elementId].push(entry);
      }

      if (!binding.clone) {
        runningAddress = fixtureAddress + layout.footprint;
      }
    }
  }

  return patchMap;
}
