// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type FaderBeatState = {
  beat: number;
  left: number;
  middle: number;
  right: number;
  travelMagnitudes: [number, number, number] | null;
};

type RandomSource = () => number;

const FADER_BEATS_PER_BAR = 4;
const FADER_TRAVEL_MAGNITUDES = [1, 3, 5] as const;
const FADER_OFFSET_LIMIT = 5;

export const INITIAL_FADER_BEAT_STATE: FaderBeatState = {
  beat: 0,
  left: 0,
  middle: 0,
  right: 0,
  travelMagnitudes: null,
};

/** Assigns travel randomly while preventing consecutive magnitude repetitions. */
function randomizedFaderTravelMagnitudes(
  previous: [number, number, number] | null,
  random: RandomSource,
): [number, number, number] {
  if (previous) {
    const forwardRotation: [number, number, number] = [
      previous[2],
      previous[0],
      previous[1],
    ];
    const backwardRotation: [number, number, number] = [
      previous[1],
      previous[2],
      previous[0],
    ];
    return random() < 0.5 ? forwardRotation : backwardRotation;
  }

  const largeIndex = Math.floor(random() * FADER_TRAVEL_MAGNITUDES.length);
  const remainingIndexes = [0, 1, 2].filter((index) => index !== largeIndex);
  const mediumIndex =
    remainingIndexes[Math.floor(random() * remainingIndexes.length)] ?? 0;
  const magnitudes: [number, number, number] = [
    FADER_TRAVEL_MAGNITUDES[0],
    FADER_TRAVEL_MAGNITUDES[0],
    FADER_TRAVEL_MAGNITUDES[0],
  ];
  magnitudes[mediumIndex] = FADER_TRAVEL_MAGNITUDES[1];
  magnitudes[largeIndex] = FADER_TRAVEL_MAGNITUDES[2];
  return magnitudes;
}

/** Moves a fader by the requested distance in a random valid direction. */
function nextFaderOffset(
  current: number,
  travelMagnitude: number,
  random: RandomSource,
): number {
  const destinations = [
    current - travelMagnitude,
    current + travelMagnitude,
  ].filter((offset) => Math.abs(offset) <= FADER_OFFSET_LIMIT);
  return destinations[Math.floor(random() * destinations.length)] ?? current;
}

/** Advances every logo fader with randomly assigned bounded travel distances. */
export function nextFaderBeatState(
  current: FaderBeatState,
  random: RandomSource = Math.random,
): FaderBeatState {
  const [leftTravel, middleTravel, rightTravel] =
    randomizedFaderTravelMagnitudes(current.travelMagnitudes, random);

  return {
    beat: (current.beat + 1) % FADER_BEATS_PER_BAR,
    left: nextFaderOffset(current.left, leftTravel, random),
    middle: nextFaderOffset(current.middle, middleTravel, random),
    right: nextFaderOffset(current.right, rightTravel, random),
    travelMagnitudes: [leftTravel, middleTravel, rightTravel],
  };
}
