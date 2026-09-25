// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";
import { getResolutionChannelWidth } from "./dmx";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
} from "./network-dmx-output-targets";

/**
 * DMX channels written for one element parameter. `parameterIndex` indexes the element's
 * `parameters` array; `width` is the parameter's channel count.
 */
export type FixturePatchChannel = {
  parameterIndex: number;
  address: number;
  width: number;
};

/**
 * One element's patch location. `transport` is `null` for console-space addresses
 * (console numbering); otherwise it is the output transport using wire numbering.
 * `channels` lists exactly the parameters the engine writes at this location, ordered by
 * address, and `address` is the first of them.
 */
export type FixturePatchEntry = {
  universe: number;
  address: number;
  transport: types.OutputTransport | null;
  channels: FixturePatchChannel[];
};

/** Console-space address of one fixture element parameter selected by a console binding. */
type ConsoleParameterAddress = {
  uid: string;
  elementId: number;
  universe: number;
  channel: FixturePatchChannel;
};

/** Console-space channels of one fixture element within one console universe. */
type ConsoleElementLocation = {
  uid: string;
  elementId: number;
  universe: number;
  channels: FixturePatchChannel[];
};

export type FixturePatchMap = Record<
  string,
  Record<string, Array<FixturePatchEntry>>
>;

/** One parameter's channel offset relative to its fixture's patch start. */
type ChannelLayout = {
  parameterIndex: number;
  offset: number;
  width: number;
};

type ElementLayout = {
  elementId: number;
  channels: ChannelLayout[];
};

type FixtureChannelLayout = {
  elements: ElementLayout[];
  totalWidth: number;
};

/** One DMX-consuming parameter of a fixture element. */
type ParameterLayoutCache = {
  parameterIndex: number;
  name: string;
  width: number;
};

type FixtureLayoutCache = {
  /** 1-based element IDs in the order the hardware consumes DMX channels. */
  elementOrder: number[];
  elements: ParameterLayoutCache[][];
};

/**
 * Hardware wiring order of fixture layouts whose DMX element order differs from their
 * logical element order. Mirrors `FixtureLayout::dmx_element_order` in
 * `crates/fixtures/src/fixture.rs`; both are pinned by
 * `crates/fixtures/tests/data/fixture_layout_dmx_element_order.json`.
 */
const FIXTURE_LAYOUT_DMX_ELEMENT_ORDER: Partial<
  Record<`${types.FixtureLayout}`, () => number[]>
> = {
  "rgb-strobe-bar": () => [
    ...inclusiveRange(48, 25),
    ...inclusiveRange(49, 72),
    ...inclusiveRange(24, 1),
  ],
  "rotating-wash-beam": () => [
    1,
    ...inclusiveRange(13, 2),
    ...inclusiveRange(14, 37),
  ],
};

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

function outputSourceMatches(
  source: types.OutputSource,
  disabled: types.OutputSource,
): boolean {
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

/** Returns the integers from `from` to `to` inclusive, counting down when `to < from`. */
function inclusiveRange(from: number, to: number): number[] {
  const step = to < from ? -1 : 1;
  const values: number[] = [];
  for (let value = from; value !== to + step; value += step) {
    values.push(value);
  }
  return values;
}

/**
 * Returns a fixture's 1-based element IDs in the order its hardware consumes DMX channels.
 *
 * Whole-fixture bindings assign channels to elements in this order: declaration order for
 * most fixtures, or the physical wiring sequence of layouts such as the RGB strobe bar and
 * rotating wash beam, matching the engine's `FixtureLayout::dmx_element_order`.
 */
export function fixtureElementIdsInDmxOrder(fixture: types.Fixture): number[] {
  const wiringOrder = fixture.layout
    ? FIXTURE_LAYOUT_DMX_ELEMENT_ORDER[fixture.layout]
    : undefined;
  if (wiringOrder) return wiringOrder();
  return fixture.elements.map((_, index) => index + 1);
}

/**
 * Caches, per fixture, the DMX-consuming parameters of each element (skipping virtual
 * intensity) with their channel widths, plus the element wiring order.
 */
function buildFixtureLayoutCache(
  fixtures: Record<string, types.Fixture>,
): Record<string, FixtureLayoutCache> {
  const cache: Record<string, FixtureLayoutCache> = {};

  for (const [uid, fixture] of Object.entries(fixtures)) {
    const elements = fixture.elements.map((element) =>
      element.parameters.flatMap((param, parameterIndex) =>
        param.attribute.type === "VirtualIntensity"
          ? []
          : [
              {
                parameterIndex,
                name: normalizeParamName(attributeName(param.attribute)),
                width: getResolutionChannelWidth(param.resolution),
              },
            ],
      ),
    );
    cache[uid] = {
      elementOrder: fixtureElementIdsInDmxOrder(fixture),
      elements,
    };
  }

  return cache;
}

/**
 * Lays out the parameters a binding's element/parameter filter selects on one fixture,
 * contiguously from offset 0, mirroring the engine's `collect_fixture_parameters`.
 *
 * Without an element filter, elements follow the fixture's DMX wiring order. A parameter
 * filter selects the one parameter per element whose attribute matches the filter.
 */
function collectFixtureLayout(
  layoutCache: FixtureLayoutCache | undefined,
  elementFilter?: number,
  paramFilter?: string,
): FixtureChannelLayout {
  if (!layoutCache) return { elements: [], totalWidth: 0 };

  const elements: ElementLayout[] = [];
  let offset = 0;
  const normalizedParam = paramFilter
    ? normalizeParamName(paramFilter)
    : undefined;
  const elementIds =
    elementFilter && elementFilter > 0
      ? [elementFilter]
      : layoutCache.elementOrder;

  for (const elementId of elementIds) {
    const parameters = layoutCache.elements[elementId - 1];
    if (!parameters) continue;

    const selected = normalizedParam
      ? parameters.filter((param) => param.name === normalizedParam).slice(0, 1)
      : parameters;
    const channels: ChannelLayout[] = [];
    for (const param of selected) {
      if (param.width === 0) continue;
      channels.push({
        parameterIndex: param.parameterIndex,
        offset,
        width: param.width,
      });
      offset += param.width;
    }
    if (channels.length > 0) {
      elements.push({ elementId, channels });
    }
  }

  return { elements, totalWidth: offset };
}

/** Builds a patch entry from address-bearing channels, ordering them by address. */
function patchEntry(
  universe: number,
  transport: types.OutputTransport | null,
  channels: FixturePatchChannel[],
): FixturePatchEntry {
  const sorted = [...channels].sort((a, b) => a.address - b.address);
  return {
    universe,
    address: sorted[0]?.address ?? DEFAULT_ADDRESS,
    transport,
    channels: sorted,
  };
}

/**
 * Projects output bindings onto per-element patch locations in console numbering and in
 * each concrete transport's wire numbering.
 *
 * Every entry lists exactly the parameter channels the engine writes there: direct
 * fixture→transport bindings, fixture→console bindings (per-parameter console layout), and
 * console→transport passthrough windows remapping those console channels onto the wire.
 * Disabled bindings and Fixture→Disabled rows suppress the fixtures they match.
 */
export function buildFixturePatchMapFromBindings(
  snapshot: types.BindingsSnapshot,
  fixtures: Record<string, types.Fixture>,
  networkDmxOutputs: types.NetworkDmxOutputTargets = defaultNetworkDmxOutputs(),
  usbDmxOutputs: types.UsbDmxOutputTargets = defaultUsbDmxOutputs(),
): FixturePatchMap {
  const patchMap: FixturePatchMap = {};
  const layoutCache = buildFixtureLayoutCache(fixtures);
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
    if (binding.source.type !== "Fixture") continue;

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

    const sourceData = binding.source.data;
    const sourceUids = normalizeFixtureUids(sourceData.uids as unknown[]);
    for (const [index, uid] of sourceUids.entries()) {
      const fixture = fixtures[uid];
      if (!fixture) continue;

      const targetUniverse = mapUniverseByIndex(universes, universes, index);
      if (targetUniverse !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = targetUniverse;
      }

      const layout = collectFixtureLayout(
        layoutCache[uid],
        sourceData.element,
        sourceData.param,
      );
      if (layout.totalWidth === 0) continue;

      const fixtureOffset = binding.clone ? 0 : runningAddress - baseAddress;

      for (const element of layout.elements) {
        pushPatchEntry(
          patchMap,
          uid,
          element.elementId,
          patchEntry(
            targetUniverse,
            outputTransport,
            element.channels.map((channel) => ({
              parameterIndex: channel.parameterIndex,
              address: baseAddress + fixtureOffset + channel.offset,
              width: channel.width,
            })),
          ),
        );
      }

      if (!binding.clone) {
        runningAddress = baseAddress + fixtureOffset + layout.totalWidth;
      }
    }
  }

  const consoleLocations = groupConsoleLocations(
    resolveConsoleAddresses(snapshot, layoutCache, disabledSources),
  );
  for (const location of consoleLocations) {
    pushPatchEntry(
      patchMap,
      location.uid,
      location.elementId,
      patchEntry(location.universe, null, location.channels),
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
        consoleLocations.map((location) => location.universe),
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
      for (const location of consoleLocations) {
        if (location.universe !== sourceUniverse) continue;

        const channels = location.channels.flatMap((channel) => {
          if (channel.address < sourceBaseAddress) return [];
          const address =
            targetBaseAddress + (channel.address - sourceBaseAddress);
          return address <= MAX_DMX_ADDRESS ? [{ ...channel, address }] : [];
        });
        if (channels.length === 0) continue;

        pushPatchEntry(
          patchMap,
          location.uid,
          location.elementId,
          patchEntry(targetUniverse, outputTransport, channels),
        );
      }
    }
  }

  return patchMap;
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
): ConsoleElementLocation[] {
  const locations = new Map<string, ConsoleElementLocation>();
  for (const address of addresses.values()) {
    const key = `${address.uid}:${address.elementId}:${address.universe}`;
    let location = locations.get(key);
    if (!location) {
      location = {
        uid: address.uid,
        elementId: address.elementId,
        universe: address.universe,
        channels: [],
      };
      locations.set(key, location);
    }
    location.channels.push(address.channel);
  }
  return Array.from(locations.values());
}

/**
 * Resolves the console-space address of each fixture element parameter selected by
 * fixture→console bindings, keyed by `uid:elementId:parameterIndex`.
 *
 * Mirrors the engine's `derive_console_addresses`: bindings apply in priority order with
 * later bindings replacing earlier ones for the parameters they select, disabled sources
 * are skipped, and each binding lays out only the parameters its element/parameter filter
 * selects, in DMX wiring order. Non-clone bindings place fixtures contiguously by that
 * filtered footprint, restarting at the base address per universe.
 */
function resolveConsoleAddresses(
  snapshot: types.BindingsSnapshot,
  layoutCache: Record<string, FixtureLayoutCache>,
  disabledSources: types.OutputSource[],
): Map<string, ConsoleParameterAddress> {
  const addresses = new Map<string, ConsoleParameterAddress>();

  for (const binding of sortOutputBindingsByPriority(snapshot.output)) {
    if (binding.source.type !== "Fixture") continue;
    if (binding.target.type !== "Console") continue;
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

    const sourceData = binding.source.data;
    const sourceUids = normalizeFixtureUids(sourceData.uids as unknown[]);
    for (const [index, uid] of sourceUids.entries()) {
      const universe = mapUniverseByIndex(universes, universes, index);
      if (universe !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = universe;
      }

      const layout = collectFixtureLayout(
        layoutCache[uid],
        sourceData.element,
        sourceData.param,
      );
      if (layout.totalWidth === 0) continue;

      for (const element of layout.elements) {
        for (const channel of element.channels) {
          const key = `${uid}:${element.elementId}:${channel.parameterIndex}`;
          addresses.delete(key);
          addresses.set(key, {
            uid,
            elementId: element.elementId,
            universe,
            channel: {
              parameterIndex: channel.parameterIndex,
              address: runningAddress + channel.offset,
              width: channel.width,
            },
          });
        }
      }
      if (!binding.clone) {
        runningAddress += layout.totalWidth;
      }
    }
  }

  return addresses;
}
