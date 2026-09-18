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

type FixturePatchEntry = {
  universe: number;
  address: number;
  transport?: types.OutputTransport;
};

export type FixturePatchMap = Record<
  string,
  Record<string, Array<FixturePatchEntry>>
>;

type ElementLayout = {
  elementId: number;
  offset: number;
  width: number;
};

type FixtureLayout = {
  elements: ElementLayout[];
  totalWidth: number;
};

type ElementLayoutCache = {
  totalWidth: number;
  paramWidths: Record<string, number>;
};

type FixtureLayoutCache = {
  elements: ElementLayoutCache[];
};

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

function buildFixtureLayoutCache(
  fixtures: Record<string, types.Fixture>,
): Record<string, FixtureLayoutCache> {
  const cache: Record<string, FixtureLayoutCache> = {};

  for (const [uid, fixture] of Object.entries(fixtures)) {
    const elements: ElementLayoutCache[] = [];

    for (const element of fixture.elements) {
      const paramWidths: Record<string, number> = {};
      let totalWidth = 0;

      for (const param of element.parameters) {
        if (param.attribute.type === "VirtualIntensity") continue;

        const width = getResolutionChannelWidth(param.resolution);
        totalWidth += width;

        const name = normalizeParamName(attributeName(param.attribute));
        paramWidths[name] = (paramWidths[name] ?? 0) + width;
      }

      elements.push({ totalWidth, paramWidths });
    }

    cache[uid] = { elements };
  }

  return cache;
}

function collectFixtureLayout(
  layoutCache: FixtureLayoutCache | undefined,
  elementFilter?: number,
  paramFilter?: string,
): FixtureLayout {
  if (!layoutCache) return { elements: [], totalWidth: 0 };

  const elements: ElementLayout[] = [];
  let offset = 0;
  const normalizedParam = paramFilter
    ? normalizeParamName(paramFilter)
    : undefined;

  const pushElement = (index: number, element?: ElementLayoutCache) => {
    if (!element) return;

    let width = 0;
    if (normalizedParam) {
      width = element.paramWidths[normalizedParam] ?? 0;
    } else {
      width = element.totalWidth;
    }

    if (width === 0) return;

    elements.push({ elementId: index + 1, offset, width });
    offset += width;
  };

  if (elementFilter && elementFilter > 0) {
    const index = elementFilter - 1;
    pushElement(index, layoutCache.elements[index]);
  } else {
    for (let index = 0; index < layoutCache.elements.length; index += 1) {
      pushElement(index, layoutCache.elements[index]);
    }
  }

  return { elements, totalWidth: offset };
}

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
        const elementAddress = baseAddress + fixtureOffset + element.offset;
        if (!patchMap[uid]) {
          patchMap[uid] = {};
        }
        const elementId = String(element.elementId);
        if (!patchMap[uid][elementId]) {
          patchMap[uid][elementId] = [];
        }
        patchMap[uid][elementId].push({
          universe: targetUniverse,
          address: elementAddress,
          transport: outputTransport,
        });
      }

      if (!binding.clone) {
        runningAddress = baseAddress + fixtureOffset + layout.totalWidth;
      }
    }
  }

  return patchMap;
}
