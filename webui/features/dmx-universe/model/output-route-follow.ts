// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CONSOLE_TRANSPORT } from "../../../lib/dmx-universe-data";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
  outputTransportKey,
} from "../../../lib/network-dmx-output-targets";
import {
  buildFixturePatchMapFromRoutes,
  type FixturePatchEntry,
  type FixturePatchMap,
} from "../../../lib/route-utils";
import type * as types from "../../../types";

/**
 * Output numbering space shown by the DMX universe panel: console space, or one concrete
 * output transport identified by its {@link outputTransportKey}. `null` matches any space.
 */
export type OutputSpaceSelection =
  | { kind: "console" }
  | { kind: "transport"; key: string }
  | null;

/**
 * Resolves the selected output numbering space from the selected view label and the
 * concrete transport reported by that label's universes.
 */
export function outputSpaceSelection(
  label: string,
  outputTransport: types.OutputTransport | null | undefined,
): OutputSpaceSelection {
  if (label === CONSOLE_TRANSPORT) return { kind: "console" };
  if (!outputTransport) return null;
  return { kind: "transport", key: outputTransportKey(outputTransport) };
}

/**
 * Returns whether a patch location belongs to the selected numbering space. Console
 * selection matches console-space locations (`null` transport) only; transport selections
 * match wire locations of that exact concrete transport.
 */
export function outputTransportMatchesSelection(
  transport: types.OutputTransport | null,
  selection: OutputSpaceSelection,
): boolean {
  if (selection === null) return true;
  if (selection.kind === "console") return transport === null;
  return transport !== null && outputTransportKey(transport) === selection.key;
}

/** Output target configuration used to resolve route target ids to transports. */
export type OutputTargetConfig = {
  networkDmxOutputs: types.NetworkDmxOutputTargets;
  usbDmxOutputs: types.UsbDmxOutputTargets;
};

/** Returns the default output target configuration. */
function defaultOutputTargets(): OutputTargetConfig {
  return {
    networkDmxOutputs: defaultNetworkDmxOutputs(),
    usbDmxOutputs: defaultUsbDmxOutputs(),
  };
}

/** Returns whether an optional DMX range contains a value; a missing range matches all. */
function rangeContains(
  range: types.DmxRange | undefined,
  value: number,
): boolean {
  if (!range) {
    return true;
  }
  return value >= range.start && value <= range.end;
}

/** Returns whether a value is a valid 1-indexed DMX address. */
function isValidAddress(address: number): boolean {
  return Number.isInteger(address) && address >= 1 && address <= 512;
}

/** Returns whether an output address falls inside a source→target channel copy window. */
function outputAddressMatchesInputMapping(
  sourceAddress: number,
  targetAddress: number,
  outputAddress: number,
): boolean {
  if (
    !isValidAddress(sourceAddress) ||
    !isValidAddress(targetAddress) ||
    !isValidAddress(outputAddress)
  ) {
    return false;
  }

  const sourceLength = 513 - sourceAddress;
  const targetLength = 513 - targetAddress;
  const copyLength = Math.min(sourceLength, targetLength);
  if (copyLength <= 0) {
    return false;
  }

  const targetEnd = targetAddress + copyLength - 1;
  return outputAddress >= targetAddress && outputAddress <= targetEnd;
}

/** Returns whether an input route writes the selected output space's channel. */
function routeProducesOutputChannel(
  route: types.InputRoute,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig,
): boolean {
  if (route.source.type !== "Transport" && route.source.type !== "Console") {
    return false;
  }

  if (route.target.type !== "Console" && route.target.type !== "Transport") {
    return false;
  }

  if (route.target.type === "Console") {
    if (selection !== null && selection.kind !== "console") {
      return false;
    }
  } else {
    if (selection?.kind === "console") {
      return false;
    }
    if (selection !== null) {
      const transport = outputTransportForOutputTargetId(
        route.target.data.target,
        targets.networkDmxOutputs,
        targets.usbDmxOutputs,
      );
      if (!transport || outputTransportKey(transport) !== selection.key) {
        return false;
      }
    }
  }

  const sourceUniverseRange = route.source.data.universe;
  const targetUniverseRange = route.target.data.universe;
  if (targetUniverseRange) {
    if (!rangeContains(targetUniverseRange, selectedUniverse)) {
      return false;
    }
  } else if (!rangeContains(sourceUniverseRange, selectedUniverse)) {
    return false;
  }

  const sourceAddress = route.source.data.address ?? 1;
  const targetAddress = route.target.data.address ?? 1;

  return outputAddressMatchesInputMapping(
    sourceAddress,
    targetAddress,
    outputAddress,
  );
}

/**
 * Finds the input route row that writes one output channel of the selected space.
 */
export function findInputRouteIdForOutputChannel(
  snapshot: types.RoutesSnapshot,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig = defaultOutputTargets(),
): string | null {
  for (const [index, route] of snapshot.input.entries()) {
    if (
      routeProducesOutputChannel(
        route,
        selection,
        selectedUniverse,
        outputAddress,
        targets,
      )
    ) {
      return `input-${index}`;
    }
  }
  return null;
}

/** Returns whether a patch location writes one DMX address through any parameter byte. */
function patchWritesAddress(patch: FixturePatchEntry, address: number) {
  return patch.parameterAddresses.some((addresses) =>
    addresses.includes(address),
  );
}

/**
 * Ranks output routes by the order the frame composer lets them win a wire channel:
 * direct fixture→transport output overlays console→transport windows, so it ranks first.
 */
function outputRoutePrecedenceTier(route: types.OutputRoute): number {
  return route.source.type === "Fixture" && route.target.type === "Transport"
    ? 0
    : 1;
}

/** Returns a key identifying one element patch location across patch maps. */
function patchLocationKey(
  fixtureUid: string,
  elementId: string,
  patch: FixturePatchEntry,
): string {
  const transport = patch.transport
    ? outputTransportKey(patch.transport)
    : CONSOLE_TRANSPORT;
  return `${fixtureUid}:${elementId}:${transport}:${patch.universe}:${patch.address}`;
}

/** Collects the location keys of every entry in a patch map. */
function patchLocationKeys(patchMap: FixturePatchMap): Set<string> {
  const keys = new Set<string>();
  for (const [fixtureUid, patchesByElement] of Object.entries(patchMap)) {
    for (const [elementId, patches] of Object.entries(patchesByElement)) {
      for (const patch of patches) {
        keys.add(patchLocationKey(fixtureUid, elementId, patch));
      }
    }
  }
  return keys;
}

/**
 * Finds the output route row driving one output channel of the selected space.
 *
 * Candidate rows are checked in the frame composer's precedence: direct fixture→transport
 * rows first (their output overlays console→transport windows on the wire), then the rest
 * from highest to lowest effective priority (later rows win ties, as in the engine). A row
 * only matches when it writes the channel itself and the location it patches is also part
 * of the effective patch map built from the full route set, so rows overridden by a
 * Fixture→Disabled row, a disabled route, or a higher-priority console route are
 * never followed.
 */
export function findOutputRouteIdForChannel(
  snapshot: types.RoutesSnapshot,
  fixtures: Record<string, types.Fixture>,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig = defaultOutputTargets(),
): string | null {
  const effectiveLocations = patchLocationKeys(
    buildFixturePatchMapFromRoutes(
      snapshot,
      fixtures,
      targets.networkDmxOutputs,
      targets.usbDmxOutputs,
    ),
  );
  const fixtureConsoleRoutes = snapshot.output.filter(
    (route) =>
      route.source.type === "Fixture" && route.target.type === "Console",
  );
  const candidates = snapshot.output
    .map((route, index) => ({ route, index }))
    .sort(
      (a, b) =>
        outputRoutePrecedenceTier(a.route) -
          outputRoutePrecedenceTier(b.route) ||
        b.route.priority - a.route.priority ||
        b.index - a.index,
    );

  for (const { route, index } of candidates) {
    const isConsolePassthrough =
      route.source.type === "Console" && route.target.type === "Transport";
    const isFixtureRoute =
      (route.source.type === "Fixture" &&
        (route.target.type === "Transport" ||
          route.target.type === "Console")) ||
      (route.source.type === "FixtureBreak" &&
        route.target.type === "Transport");
    if (!isConsolePassthrough && !isFixtureRoute) continue;

    const patchMap = buildFixturePatchMapFromRoutes(
      {
        input: [],
        output: isConsolePassthrough
          ? [...fixtureConsoleRoutes, route]
          : [route],
        disabled: snapshot.disabled,
      },
      fixtures,
      targets.networkDmxOutputs,
      targets.usbDmxOutputs,
    );
    for (const [fixtureUid, patchesByElement] of Object.entries(patchMap)) {
      for (const [elementId, patches] of Object.entries(patchesByElement)) {
        for (const patch of patches) {
          if (isConsolePassthrough && patch.transport === null) continue;
          if (
            patch.universe === selectedUniverse &&
            outputTransportMatchesSelection(patch.transport, selection) &&
            patchWritesAddress(patch, outputAddress) &&
            effectiveLocations.has(
              patchLocationKey(fixtureUid, elementId, patch),
            )
          )
            return `output-${index}`;
        }
      }
    }
  }
  return null;
}
