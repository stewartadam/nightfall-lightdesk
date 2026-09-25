// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import { type FixtureWireLayout, fixtureWireLayout } from "./dmx";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
} from "./network-dmx-output-targets";

/**
 * One element's patch location. `transport` is `null` for console-space addresses
 * (console numbering); otherwise it is the output transport using wire numbering.
 */
export type FixturePatchEntry = {
  universe: number;
  /** Address of the element's first patched byte. */
  address: number;
  /** Byte addresses per element parameter index, most significant first; empty when unpatched. */
  parameterAddresses: number[][];
  transport: types.OutputTransport | null;
};

type ConsoleAddress = {
  universe: number;
  address: number;
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

      const layout = bindingWireLayout(fixture, sourceData);
      if (layout.footprint === 0) continue;

      const fixtureAddress = binding.clone ? baseAddress : runningAddress;
      pushLayoutEntries(
        patchMap,
        uid,
        fixture,
        layout,
        targetUniverse,
        outputTransport,
        (slot) => fixtureAddress + slot,
      );

      if (!binding.clone) {
        runningAddress = fixtureAddress + layout.footprint;
      }
    }
  }

  const consoleAddresses = resolveConsoleAddresses(
    snapshot,
    fixtures,
    disabledSources,
  );
  for (const [uid, consoleAddress] of consoleAddresses) {
    const fixture = fixtures[uid];
    if (!fixture) continue;
    pushLayoutEntries(
      patchMap,
      uid,
      fixture,
      fixtureWireLayout(fixture),
      consoleAddress.universe,
      null,
      (slot) => consoleAddress.address + slot,
    );
  }

  for (const binding of sortOutputBindingsByPriority(snapshot.output)) {
    if (binding.source.type !== "Console") continue;
    if (binding.target.type !== "Transport") continue;
    if (
      disabledSources.some((source) =>
        outputSourceMatches(binding.source, source),
      )
    ) {
      continue;
    }

    const targetData = binding.target.data;
    const outputTransport = outputTargetIdToTransport(
      targetData.target,
      networkDmxOutputs,
      usbDmxOutputs,
    );
    if (!outputTransport) continue;

    const sourceData = binding.source.data;
    let sourceUniverses = expandRange(sourceData.universe);
    if (sourceUniverses.length === 0) {
      const consoleUniverses = new Set(
        Array.from(consoleAddresses.values(), (address) => address.universe),
      );
      sourceUniverses =
        consoleUniverses.size > 0
          ? Array.from(consoleUniverses).sort((a, b) => a - b)
          : [DEFAULT_UNIVERSE];
    }
    const explicitTargetUniverses = expandRange(targetData.universe);
    const targetUniverses =
      explicitTargetUniverses.length > 0
        ? explicitTargetUniverses
        : sourceUniverses;
    const sourceBaseAddress = sourceData.address ?? DEFAULT_ADDRESS;
    const targetBaseAddress = targetData.address ?? DEFAULT_ADDRESS;

    for (const [index, sourceUniverse] of sourceUniverses.entries()) {
      const targetUniverse = mapUniverseByIndex(
        sourceUniverses,
        targetUniverses,
        index,
      );
      for (const [uid, consoleAddress] of consoleAddresses) {
        if (consoleAddress.universe !== sourceUniverse) continue;
        if (consoleAddress.address < sourceBaseAddress) continue;

        const fixture = fixtures[uid];
        if (!fixture) continue;
        const fixtureAddress =
          targetBaseAddress + (consoleAddress.address - sourceBaseAddress);
        pushLayoutEntries(
          patchMap,
          uid,
          fixture,
          fixtureWireLayout(fixture),
          targetUniverse,
          outputTransport,
          (slot) => fixtureAddress + slot,
        );
      }
    }
  }

  return patchMap;
}

/**
 * Lays out the parameters a fixture output selection picks on one fixture — its DMX
 * break, optionally narrowed to one element and parameter — mirroring the engine's
 * `collect_fixture_parameters`.
 */
function bindingWireLayout(
  fixture: types.Fixture,
  selection: FixtureOutputSelection,
): FixtureWireLayout {
  const normalizedParam = selection.param
    ? normalizeParamName(selection.param)
    : undefined;
  return fixtureWireLayout(fixture, {
    elementId: selection.element,
    dmxBreak: selection.dmxBreak,
    includeParameter: normalizedParam
      ? (parameter) =>
          normalizeParamName(attributeName(parameter.attribute)) ===
          normalizedParam
      : undefined,
  });
}

/**
 * Appends one patch entry per element of a laid-out fixture, placing each byte at the
 * address `addressOf` returns for its footprint slot.
 */
function pushLayoutEntries(
  patchMap: FixturePatchMap,
  uid: string,
  fixture: types.Fixture,
  layout: FixtureWireLayout,
  universe: number,
  transport: types.OutputTransport | null,
  addressOf: (slot: number) => number,
): void {
  const entries = new Map<number, FixturePatchEntry>();
  for (const placed of layout.parameters) {
    const addresses = placed.slots.map(addressOf);
    let entry = entries.get(placed.elementIndex);
    if (!entry) {
      entry = {
        universe,
        address: Number.POSITIVE_INFINITY,
        parameterAddresses: fixture.elements[
          placed.elementIndex
        ].parameters.map(() => []),
        transport,
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
}

/** Orders output bindings by ascending priority, keeping insertion order for ties. */
function sortOutputBindingsByPriority(
  bindings: types.OutputBinding[],
): types.OutputBinding[] {
  return bindings
    .map((binding, index) => ({ binding, index }))
    .sort(
      (a, b) => a.binding.priority - b.binding.priority || a.index - b.index,
    )
    .map(({ binding }) => binding);
}

/**
 * Resolves each fixture's console-space start address from fixture→console bindings.
 *
 * Mirrors the engine's console address derivation: bindings apply in priority order with
 * later bindings replacing earlier ones, disabled sources are skipped, and non-clone
 * bindings lay fixtures out contiguously, restarting at the base address per universe.
 */
function resolveConsoleAddresses(
  snapshot: types.BindingsSnapshot,
  fixtures: Record<string, types.Fixture>,
  disabledSources: types.OutputSource[],
): Map<string, ConsoleAddress> {
  const addresses = new Map<string, ConsoleAddress>();

  for (const binding of sortOutputBindingsByPriority(snapshot.output)) {
    if (binding.target.type !== "Console") continue;
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
    const explicitUniverses = expandRange(targetData.universe);
    const universes =
      explicitUniverses.length > 0 ? explicitUniverses : [DEFAULT_UNIVERSE];
    const baseAddress = targetData.address ?? DEFAULT_ADDRESS;
    let runningAddress = baseAddress;
    let lastUniverse = universes[0];

    const sourceUids = normalizeFixtureUids(sourceData.uids);
    for (const [index, uid] of sourceUids.entries()) {
      const universe = mapUniverseByIndex(universes, universes, index);
      if (universe !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = universe;
      }

      const fixture = fixtures[uid];
      if (!fixture) continue;
      const layout = bindingWireLayout(fixture, sourceData);
      if (layout.footprint === 0) continue;

      addresses.set(uid, { universe, address: runningAddress });
      if (!binding.clone) {
        runningAddress += layout.footprint;
      }
    }
  }

  return addresses;
}
