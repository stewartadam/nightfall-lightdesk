// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  buildFixturePatchMapFromBindings,
  type FixturePatchEntry,
  type FixturePatchMap,
} from "../../../lib/binding-utils";
import { getResolutionChannelWidth } from "../../../lib/dmx";
import { CONSOLE_TRANSPORT } from "../../../lib/dmx-universe-data";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  outputTransportForOutputTargetId,
  outputTransportKey,
} from "../../../lib/network-dmx-output-targets";
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

/** Output target configuration used to resolve binding target ids to transports. */
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

/** Returns whether an input binding writes the selected output space's channel. */
function bindingProducesOutputChannel(
  binding: types.InputBinding,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig,
): boolean {
  if (
    binding.source.type !== "Transport" &&
    binding.source.type !== "Console"
  ) {
    return false;
  }

  if (
    binding.target.type !== "Console" &&
    binding.target.type !== "Transport"
  ) {
    return false;
  }

  if (binding.target.type === "Console") {
    if (selection !== null && selection.kind !== "console") {
      return false;
    }
  } else {
    if (selection?.kind === "console") {
      return false;
    }
    if (selection !== null) {
      const transport = outputTransportForOutputTargetId(
        binding.target.data.target,
        targets.networkDmxOutputs,
        targets.usbDmxOutputs,
      );
      if (!transport || outputTransportKey(transport) !== selection.key) {
        return false;
      }
    }
  }

  const sourceUniverseRange = binding.source.data.universe;
  const targetUniverseRange = binding.target.data.universe;
  if (targetUniverseRange) {
    if (!rangeContains(targetUniverseRange, selectedUniverse)) {
      return false;
    }
  } else if (!rangeContains(sourceUniverseRange, selectedUniverse)) {
    return false;
  }

  const sourceAddress = binding.source.data.address ?? 1;
  const targetAddress = binding.target.data.address ?? 1;

  return outputAddressMatchesInputMapping(
    sourceAddress,
    targetAddress,
    outputAddress,
  );
}

/**
 * Finds the input binding row that writes one output channel of the selected space.
 */
export function findInputBindingIdForOutputChannel(
  snapshot: types.BindingsSnapshot,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig = defaultOutputTargets(),
): string | null {
  for (const [index, binding] of snapshot.input.entries()) {
    if (
      bindingProducesOutputChannel(
        binding,
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

/** Calculates the number of physical DMX channels used by one fixture element. */
function elementChannelWidth(fixture: types.Fixture, elementId: number) {
  const element = fixture.elements[elementId - 1];
  if (!element) return 0;
  return element.parameters.reduce(
    (width, parameter) =>
      parameter.attribute.type === "VirtualIntensity"
        ? width
        : width + getResolutionChannelWidth(parameter.resolution),
    0,
  );
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
 * Finds the output binding row driving one output channel of the selected space.
 *
 * Candidate rows are checked from highest to lowest effective priority (later rows win
 * ties, as in the engine). A row only matches when the location it patches is also part
 * of the effective patch map built from the full binding set, so rows overridden by a
 * Fixture→Disabled row, a disabled binding, or a higher-priority console binding are
 * never followed.
 */
export function findOutputBindingIdForChannel(
  snapshot: types.BindingsSnapshot,
  fixtures: Record<string, types.Fixture>,
  selection: OutputSpaceSelection,
  selectedUniverse: number,
  outputAddress: number,
  targets: OutputTargetConfig = defaultOutputTargets(),
): string | null {
  const effectiveLocations = patchLocationKeys(
    buildFixturePatchMapFromBindings(
      snapshot,
      fixtures,
      targets.networkDmxOutputs,
      targets.usbDmxOutputs,
    ),
  );
  const fixtureConsoleBindings = snapshot.output.filter(
    (binding) =>
      binding.source.type === "Fixture" && binding.target.type === "Console",
  );
  const candidates = snapshot.output
    .map((binding, index) => ({ binding, index }))
    .sort(
      (a, b) => b.binding.priority - a.binding.priority || b.index - a.index,
    );

  for (const { binding, index } of candidates) {
    const isConsolePassthrough =
      binding.source.type === "Console" && binding.target.type === "Transport";
    const isFixtureBinding =
      binding.source.type === "Fixture" &&
      (binding.target.type === "Transport" ||
        binding.target.type === "Console");
    if (!isConsolePassthrough && !isFixtureBinding) continue;

    const patchMap = buildFixturePatchMapFromBindings(
      {
        input: [],
        output: isConsolePassthrough
          ? [...fixtureConsoleBindings, binding]
          : [binding],
        disabled: snapshot.disabled,
      },
      fixtures,
      targets.networkDmxOutputs,
      targets.usbDmxOutputs,
    );
    for (const [fixtureUid, patchesByElement] of Object.entries(patchMap)) {
      const fixture = fixtures[fixtureUid];
      if (!fixture) continue;
      for (const [elementId, patches] of Object.entries(patchesByElement)) {
        const width = elementChannelWidth(
          fixture,
          Number.parseInt(elementId, 10),
        );
        if (width <= 0) continue;
        for (const patch of patches) {
          if (isConsolePassthrough && patch.transport === null) continue;
          if (
            patch.universe === selectedUniverse &&
            outputTransportMatchesSelection(patch.transport, selection) &&
            outputAddress >= patch.address &&
            outputAddress <= patch.address + width - 1 &&
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
