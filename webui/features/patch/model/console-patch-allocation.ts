// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fixtureWireLayout } from "../../../lib/dmx";
import { normalizeFixtureUid } from "../../../lib/route-utils";
import type * as types from "../../../types";

/** Number of channels in one console DMX universe. */
export const CONSOLE_UNIVERSE_SIZE = 512;

/** Console universe and start address of one patched fixture. */
export interface ConsolePatchPlacement {
  universe: number;
  address: number;
}

/** Console channels already used by fixtures, keyed by `${universe}:${address}`. */
export type ConsoleOccupancy = Map<string, { label: string }>;

/** First reason a planned console patch cannot be applied as is. */
export type ConsolePatchProblem =
  | { kind: "overrun"; universe: number; address: number }
  | { kind: "conflict"; universe: number; address: number; label: string };

/** Builds the occupancy key of one console channel. */
function occupancyKey(universe: number, address: number): string {
  return `${universe}:${address}`;
}

/** Picks the universe of the Nth fixture of a route the way the engine's patch layout does. */
function mapUniverseByIndex(universes: number[], index: number): number {
  if (universes.length === 0) return 1;
  return universes[Math.min(index, universes.length - 1)];
}

/**
 * Collects every console channel used by fixture→console routes, labelled with the
 * fixture that uses it.
 *
 * Fixtures are laid out like the engine lays out a route: the Nth fixture lands in the
 * Nth universe of the route's range (the last universe takes the rest), each universe
 * starts at the route address, and fixtures sharing a universe are packed one after
 * another unless the route clones them onto the same address.
 */
export function collectConsolePatchOccupancy(
  snapshot: types.RoutesSnapshot,
  fixtureMap: Record<string, types.Fixture>,
): ConsoleOccupancy {
  const occupied: ConsoleOccupancy = new Map();

  for (const route of snapshot.output) {
    if (route.source.type !== "Fixture") continue;
    if (route.target.type !== "Console") continue;

    const sourceData = route.source.data;
    const targetData = route.target.data;
    const range = targetData.universe;
    const universes = range
      ? Array.from(
          { length: range.end - range.start + 1 },
          (_, index) => range.start + index,
        )
      : [1];
    const baseAddress = targetData.address ?? 1;

    let runningAddress = baseAddress;
    let lastUniverse = universes[0] ?? 1;

    for (const [index, uid] of sourceData.uids.entries()) {
      const fixture = fixtureMap[normalizeFixtureUid(uid)];
      if (!fixture) continue;

      const universe = mapUniverseByIndex(universes, index);
      if (universe !== lastUniverse) {
        runningAddress = baseAddress;
        lastUniverse = universe;
      }

      const footprint = fixtureWireLayout(fixture, {
        elementId: sourceData.element,
        parameterName: sourceData.param || undefined,
      }).footprint;
      if (footprint <= 0) continue;

      const startAddress = route.clone ? baseAddress : runningAddress;
      const endAddress = startAddress + footprint - 1;
      if (!route.clone) {
        runningAddress = endAddress + 1;
      }

      const label =
        fixture.identifiers.label || `Fixture ${fixture.identifiers.id}`;
      for (let address = startAddress; address <= endAddress; address += 1) {
        occupied.set(occupancyKey(universe, address), { label });
      }
    }
  }

  return occupied;
}

/**
 * Lays out `quantity` fixtures of `footprint` channels from a console start address.
 *
 * Fixtures are packed one after another. A fixture that would run past the end of its
 * universe starts at address 1 of the next universe instead, so no fixture is split
 * across two universes. Only the first fixture can run past the end, when the start
 * address leaves too little room for it; {@link findConsolePatchProblem} reports that.
 */
export function layoutConsolePatch(
  start: ConsolePatchPlacement,
  footprint: number,
  quantity: number,
): ConsolePatchPlacement[] {
  const placements: ConsolePatchPlacement[] = [];
  let { universe, address } = start;
  for (let index = 0; index < quantity; index += 1) {
    if (index > 0 && address + footprint - 1 > CONSOLE_UNIVERSE_SIZE) {
      universe += 1;
      address = 1;
    }
    placements.push({ universe, address });
    address += footprint;
  }
  return placements;
}

/**
 * Returns the first channel that keeps a planned patch from being applied: a fixture
 * running past the last channel of its universe, or a channel another fixture already
 * uses. Returns null when every fixture fits on free channels.
 */
export function findConsolePatchProblem(
  occupied: ConsoleOccupancy,
  placements: ConsolePatchPlacement[],
  footprint: number,
): ConsolePatchProblem | null {
  for (const { universe, address } of placements) {
    for (let offset = 0; offset < footprint; offset += 1) {
      const channel = address + offset;
      if (channel > CONSOLE_UNIVERSE_SIZE) {
        return { kind: "overrun", universe, address: channel };
      }
      const owner = occupied.get(occupancyKey(universe, channel));
      if (owner) {
        return {
          kind: "conflict",
          universe,
          address: channel,
          label: owner.label,
        };
      }
    }
  }
  return null;
}

/** Returns the highest universe with a used console channel, or 0 when none are used. */
function highestOccupiedUniverse(occupied: ConsoleOccupancy): number {
  let highest = 0;
  for (const key of occupied.keys()) {
    highest = Math.max(highest, Number.parseInt(key, 10));
  }
  return highest;
}

/**
 * Returns the next start address worth trying in `universe` after the start at
 * `address` failed on `problem`, skipping starts that are bound to fail the same way.
 *
 * A used channel in the start universe stays covered by the packed fixtures for every
 * later start up to that channel, as long as it lies in the first fixture or before the
 * last full footprint of the universe, so the search resumes just past it. A problem in
 * a later universe repeats for every start that fits the same number of fixtures in the
 * start universe, so the search resumes at the first start that fits one fixture fewer.
 */
function nextCandidateAddress(
  problem: ConsolePatchProblem,
  universe: number,
  address: number,
  footprint: number,
): number {
  if (problem.universe === universe) {
    const alwaysCovered =
      problem.address < address + footprint ||
      problem.address <= CONSOLE_UNIVERSE_SIZE + 1 - footprint;
    return alwaysCovered ? problem.address + 1 : address + 1;
  }
  const fixturesInUniverse = Math.floor(
    (CONSOLE_UNIVERSE_SIZE + 1 - address) / footprint,
  );
  return CONSOLE_UNIVERSE_SIZE + 2 - fixturesInUniverse * footprint;
}

/**
 * Finds the lowest console start address where `quantity` fixtures of `footprint`
 * channels all land on free channels, laid out by {@link layoutConsolePatch}.
 *
 * The search starts at address 1 of `fromUniverse` and moves through later universes
 * until the whole patch fits; a universe past every used channel always fits. With
 * `withinUniverse`, only start addresses in `fromUniverse` are tried and null is
 * returned when none fits there. Returns null for footprints wider than a universe.
 */
export function findFirstFreeConsolePatch(
  occupied: ConsoleOccupancy,
  footprint: number,
  quantity: number,
  fromUniverse: number,
  options: { withinUniverse?: boolean } = {},
): ConsolePatchPlacement | null {
  if (footprint < 1 || footprint > CONSOLE_UNIVERSE_SIZE || quantity < 1) {
    return null;
  }
  const lastUniverse = options.withinUniverse
    ? fromUniverse
    : Math.max(fromUniverse, highestOccupiedUniverse(occupied) + 1);

  for (let universe = fromUniverse; universe <= lastUniverse; universe += 1) {
    let address = 1;
    while (address + footprint - 1 <= CONSOLE_UNIVERSE_SIZE) {
      const start = { universe, address };
      const problem = findConsolePatchProblem(
        occupied,
        layoutConsolePatch(start, footprint, quantity),
        footprint,
      );
      if (!problem) return start;
      address = nextCandidateAddress(problem, universe, address, footprint);
    }
  }
  return null;
}

/**
 * Formats the console channels a patch spans, as `start-end` within one universe or
 * `universe.start-universe.end` across several.
 */
export function formatConsolePatchSpan(
  placements: ConsolePatchPlacement[],
  footprint: number,
): string {
  const first = placements[0];
  const last = placements[placements.length - 1];
  if (!first || !last) return "";
  const endAddress = last.address + Math.max(footprint, 1) - 1;
  return first.universe === last.universe
    ? `${first.address}-${endAddress}`
    : `${first.universe}.${first.address}-${last.universe}.${endAddress}`;
}
