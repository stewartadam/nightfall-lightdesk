// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

export type OutputTransportSelection = string | null;

function rangeContains(
  range: types.DmxRange | undefined,
  value: number,
): boolean {
  if (!range) {
    return true;
  }
  return value >= range.start && value <= range.end;
}

function isValidAddress(address: number): boolean {
  return Number.isInteger(address) && address >= 1 && address <= 512;
}

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

function bindingProducesOutputChannel(
  binding: types.InputBinding,
  selectedTransport: OutputTransportSelection,
  selectedUniverse: number,
  outputAddress: number,
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
    if (selectedTransport !== null && selectedTransport !== "console") {
      return false;
    }
  } else {
    if (selectedTransport === "console") {
      return false;
    }
    if (selectedTransport !== null) {
      if (binding.target.data.target !== selectedTransport) {
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
 * Find input binding ID for output channel.
 */
export function findInputBindingIdForOutputChannel(
  snapshot: types.BindingsSnapshot,
  selectedTransport: OutputTransportSelection,
  selectedUniverse: number,
  outputAddress: number,
): string | null {
  for (const [index, binding] of snapshot.input.entries()) {
    if (
      bindingProducesOutputChannel(
        binding,
        selectedTransport,
        selectedUniverse,
        outputAddress,
      )
    ) {
      return `input-${index}`;
    }
  }
  return null;
}
