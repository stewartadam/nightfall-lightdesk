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
 * `parameterAddresses` lists exactly the bytes the engine writes at this location, per
 * element parameter, and `address` is the lowest of them.
 */
export type FixturePatchEntry = {
  universe: number;
  /** Address of the element's first patched byte. */
  address: number;
  /** Byte addresses per element parameter index, most significant first; empty when unpatched. */
  parameterAddresses: number[][];
  transport: types.OutputTransport | null;
};

/** Console-space byte addresses of one fixture element parameter selected by a console binding. */
type ConsoleParameterAddress = {
  uid: string;
  elementId: number;
  parameterIndex: number;
  universe: number;
  /** Console address of every byte, most significant first. */
  addresses: number[];
};

/** Console-space patch location of one fixture element within one console universe. */
type ConsoleElementLocation = {
  uid: string;
  elementId: number;
  entry: FixturePatchEntry;
};

export type FixturePatchMap = Record<
  string,
  Record<string, Array<FixturePatchEntry>>
>;

const DEFAULT_UNIVERSE = 1;
const DEFAULT_ADDRESS = 1;
const MAX_DMX_ADDRESS = 512;

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

/**
 * Projects output bindings onto per-element patch locations in console numbering and in
 * each concrete transport's wire numbering.
 *
 * Every entry lists exactly the parameter bytes the engine writes there, placed by the
 * fixture's wire layout (DMX element order, explicit footprint slots and gaps): direct
 * fixture→transport bindings, fixture→console bindings (per-parameter console layout), and
 * console→transport passthrough windows remapping those console bytes onto the wire.
 * Disabled bindings and Fixture→Disabled rows suppress the fixtures they match.
 */
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
      const entries = layoutElementEntries(
        fixture,
        layout,
        targetUniverse,
        outputTransport,
        (slot) => fixtureAddress + slot,
      );
      for (const [elementIndex, entry] of entries) {
        pushPatchEntry(patchMap, uid, elementIndex + 1, entry);
      }

      if (!binding.clone) {
        runningAddress = fixtureAddress + layout.footprint;
      }
    }
  }

  const consoleLocations = groupConsoleLocations(
    resolveConsoleAddresses(snapshot, fixtures, disabledSources),
    fixtures,
  );
  for (const location of consoleLocations) {
    pushPatchEntry(patchMap, location.uid, location.elementId, location.entry);
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
        consoleLocations.map((location) => location.entry.universe),
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
    const remap = (address: number) =>
      targetBaseAddress + (address - sourceBaseAddress);

    for (const [index, sourceUniverse] of sourceUniverses.entries()) {
      const targetUniverse = mapUniverseByIndex(
        sourceUniverses,
        targetUniverses,
        index,
      );
      for (const location of consoleLocations) {
        if (location.entry.universe !== sourceUniverse) continue;

        const parameterAddresses = location.entry.parameterAddresses.map(
          (addresses) =>
            addresses.length > 0 &&
            addresses.every(
              (address) =>
                address >= sourceBaseAddress &&
                remap(address) <= MAX_DMX_ADDRESS,
            )
              ? addresses.map(remap)
              : [],
        );
        const entry = patchEntry(
          targetUniverse,
          outputTransport,
          parameterAddresses,
        );
        if (!entry) continue;

        pushPatchEntry(patchMap, location.uid, location.elementId, entry);
      }
    }
  }

  return patchMap;
}

/**
 * Lays out the parameters a fixture output selection picks on one fixture, mirroring the
 * engine's `collect_fixture_parameters`: the selection's DMX break, elements in DMX wiring
 * order, one matching parameter per element for a parameter filter, and explicit
 * footprint slots.
 */
function bindingWireLayout(
  fixture: types.Fixture,
  selection: FixtureOutputSelection,
): FixtureWireLayout {
  return fixtureWireLayout(fixture, {
    elementId: selection.element,
    parameterName: selection.param || undefined,
    dmxBreak: selection.dmxBreak,
  });
}

/** Appends one element patch location, creating the fixture and element buckets on demand. */
function pushPatchEntry(
  patchMap: FixturePatchMap,
  uid: string,
  elementId: number,
  entry: FixturePatchEntry,
): void {
  patchMap[uid] ??= {};
  const key = String(elementId);
  patchMap[uid][key] ??= [];
  patchMap[uid][key].push(entry);
}

/**
 * Builds a patch entry from per-parameter byte addresses, using the lowest byte as the
 * entry address. Returns `null` when no parameter has a byte at this location.
 */
function patchEntry(
  universe: number,
  transport: types.OutputTransport | null,
  parameterAddresses: number[][],
): FixturePatchEntry | null {
  const allAddresses = parameterAddresses.flat();
  if (allAddresses.length === 0) return null;
  return {
    universe,
    address: Math.min(...allAddresses),
    parameterAddresses,
    transport,
  };
}

/**
 * Groups a fixture's laid-out parameters into one patch entry per element (keyed by
 * zero-based element index), placing each byte at the address `addressOf` returns for its
 * footprint slot.
 */
function layoutElementEntries(
  fixture: types.Fixture,
  layout: FixtureWireLayout,
  universe: number,
  transport: types.OutputTransport | null,
  addressOf: (slot: number) => number,
): Map<number, FixturePatchEntry> {
  const parameterAddressesByElement = new Map<number, number[][]>();
  for (const placed of layout.parameters) {
    let parameterAddresses = parameterAddressesByElement.get(
      placed.elementIndex,
    );
    if (!parameterAddresses) {
      parameterAddresses = fixture.elements[placed.elementIndex].parameters.map(
        () => [],
      );
      parameterAddressesByElement.set(placed.elementIndex, parameterAddresses);
    }
    parameterAddresses[placed.parameterIndex] = placed.slots.map(addressOf);
  }

  const entries = new Map<number, FixturePatchEntry>();
  for (const [
    elementIndex,
    parameterAddresses,
  ] of parameterAddressesByElement) {
    const entry = patchEntry(universe, transport, parameterAddresses);
    if (entry) entries.set(elementIndex, entry);
  }
  return entries;
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
 * Groups per-parameter console addresses into one location per fixture element and
 * console universe, preserving first-seen order.
 */
function groupConsoleLocations(
  addresses: Map<string, ConsoleParameterAddress>,
  fixtures: Record<string, types.Fixture>,
): ConsoleElementLocation[] {
  const grouped = new Map<
    string,
    { uid: string; elementId: number; universe: number; addresses: number[][] }
  >();
  for (const address of addresses.values()) {
    const key = `${address.uid}:${address.elementId}:${address.universe}`;
    let location = grouped.get(key);
    if (!location) {
      const parameters =
        fixtures[address.uid]?.elements[address.elementId - 1]?.parameters ??
        [];
      location = {
        uid: address.uid,
        elementId: address.elementId,
        universe: address.universe,
        addresses: parameters.map(() => []),
      };
      grouped.set(key, location);
    }
    location.addresses[address.parameterIndex] = address.addresses;
  }

  const locations: ConsoleElementLocation[] = [];
  for (const location of grouped.values()) {
    const entry = patchEntry(location.universe, null, location.addresses);
    if (!entry) continue;
    locations.push({ uid: location.uid, elementId: location.elementId, entry });
  }
  return locations;
}

/**
 * Resolves the console-space byte addresses of each fixture element parameter selected by
 * fixture→console bindings, keyed by `uid:elementId:parameterIndex`.
 *
 * Mirrors the engine's `derive_console_addresses`: bindings apply in priority order with
 * later bindings replacing earlier ones for the parameters they select, disabled sources
 * are skipped, and each binding lays out only the parameters its element/parameter filter
 * selects with the fixture's wire layout (DMX wiring order, explicit footprint slots).
 * Non-clone bindings place fixtures one after another by that filtered footprint,
 * restarting at the base address per universe.
 */
function resolveConsoleAddresses(
  snapshot: types.BindingsSnapshot,
  fixtures: Record<string, types.Fixture>,
  disabledSources: types.OutputSource[],
): Map<string, ConsoleParameterAddress> {
  const addresses = new Map<string, ConsoleParameterAddress>();

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

      for (const placed of layout.parameters) {
        const elementId = placed.elementIndex + 1;
        const key = `${uid}:${elementId}:${placed.parameterIndex}`;
        addresses.delete(key);
        addresses.set(key, {
          uid,
          elementId,
          parameterIndex: placed.parameterIndex,
          universe,
          addresses: placed.slots.map((slot) => runningAddress + slot),
        });
      }
      if (!binding.clone) {
        runningAddress += layout.footprint;
      }
    }
  }

  return addresses;
}
