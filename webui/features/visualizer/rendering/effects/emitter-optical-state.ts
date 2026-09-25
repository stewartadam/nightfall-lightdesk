// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type OpticalFunction, PhysicalUnit } from "../../../../types";
import type { EmitterData } from "../../model/types";
import type { EmitterColor } from "../geometry-builder";
import type { GoboAtlasSlot } from "./gobo-atlas";
import {
  createOpticalChannelState,
  evaluateOpticalChannel,
} from "./optical-channel";
import {
  compilePrismFacet,
  type PrismProjection,
  PrismStack,
  type PrismStage,
} from "./prism-optics";

/** One independently controlled mask in the emitter's optical path; slot zero transmits fully. */
export interface GoboStage {
  slot: number;
  rotation: number;
}

/** Optical controls an aperture publishes each frame, independent of its pose and color. */
export interface ApertureControls {
  /** Full beam angle selected by a degree-valued zoom channel, when present. */
  readonly zoomDegrees: number | undefined;
  /** Every mask stage in the optical path, in wheel order. */
  readonly gobos: readonly GoboStage[];
  /** Facets of the selected prism split, or undefined when the beam is not split. */
  readonly prism: readonly PrismProjection[] | undefined;
  readonly prismRotation: number;
  /** Distance to the focal plane in meters; 0 keeps masks at their default focus. */
  readonly focusDistance: number;
}

/** Controls of an aperture without optical channels: an unsplit, unmasked, unzoomed beam. */
export const OPEN_APERTURE: ApertureControls = {
  zoomDegrees: undefined,
  gobos: [],
  prism: undefined,
  prismRotation: 0,
  focusDistance: 0,
};

/** Upper bound on prepared prism facets per aperture, however many prism stages multiply. */
const MAX_PREPARED_FACETS = 1024;

/** Compiles inherited controls and image handles once, then updates only numeric optical state. */
export class EmitterOpticalState implements ApertureControls {
  readonly gobos: GoboStage[] = [];
  private readonly goboFunctions = new Map<OpticalFunction, GoboStage>();
  prism: readonly PrismProjection[] | undefined;
  prismRotation = 0;
  focusDistance = 0;
  zoomDegrees: number | undefined;
  maxFacetCount = 1;
  private readonly prisms = new Map<string, PrismProjection[][]>();
  private readonly channels;
  private lastTime: number | undefined;
  private readonly wheels = new Map<string, (GoboAtlasSlot | undefined)[]>();
  private readonly prismStages: PrismStage[] = [];
  private readonly prismFunctions = new Map<OpticalFunction, PrismStage>();
  private readonly prismStack: PrismStack | undefined;
  /** Explicitly reports fixtures whose prepared prism product exceeds the rendering budget. */
  readonly prismCapacityExceeded: boolean;
  /** True only while the current DMX-selected split is being approximated. */
  prismReduced = false;

  /** Preloads declared wheel media before playback begins. */
  constructor(
    emitter: EmitterData,
    load: (path: string, media: string) => GoboAtlasSlot,
  ) {
    const rotations = new Map<string, { angle: number }>();
    this.channels = (emitter.opticalChannels ?? []).map((channel) => ({
      channel,
      state: createOpticalChannelState(),
      rotations: new Map(
        channel.functions.flatMap((fn) => {
          const family = /^(Gobo\d*|Prism\d*)Pos(?:Rotate)?$/.exec(
            fn.attribute,
          )?.[1];
          if (!family) return [];
          let rotation = rotations.get(family);
          if (!rotation) {
            rotation = { angle: 0 };
            rotations.set(family, rotation);
          }
          return [[fn, rotation] as const];
        }),
      ),
    }));
    const goboFamilies = new Map<string, GoboStage>();
    for (const { channel } of this.channels) {
      for (const fn of channel.functions) {
        const family = /^(Gobo\d*)(?:Pos(?:Rotate)?)?$/.exec(fn.attribute)?.[1];
        if (!family) continue;
        let stage = goboFamilies.get(family);
        if (!stage) {
          stage = { slot: 0, rotation: 0 };
          goboFamilies.set(family, stage);
          this.gobos.push(stage);
        }
        this.goboFunctions.set(fn, stage);
      }
    }
    const referencedWheels = new Set(
      this.channels.flatMap(({ channel }) =>
        channel.functions.flatMap((fn) => (fn.wheel ? [fn.wheel] : [])),
      ),
    );
    for (const wheel of emitter.opticalWheels ?? []) {
      if (!referencedWheels.has(wheel.name)) continue;
      this.prisms.set(
        wheel.name,
        wheel.slots.map((slot) =>
          slot.facets
            .map(compilePrismFacet)
            .filter((facet): facet is PrismProjection => facet !== undefined),
        ),
      );
      for (const facets of this.prisms.get(wheel.name)!)
        this.maxFacetCount = Math.max(this.maxFacetCount, facets.length);
      this.wheels.set(
        wheel.name,
        wheel.slots.map((slot) =>
          slot.mediaName && emitter.gdtfPath
            ? load(emitter.gdtfPath, slot.mediaName)
            : undefined,
        ),
      );
    }
    const stages = new Map<
      string,
      { stage: PrismStage; capacity: number; counts: Set<number> }
    >();
    for (const { channel } of this.channels) {
      for (const fn of channel.functions) {
        const family = /^(Prism\d*)(?:Pos(?:Rotate)?)?$/.exec(
          fn.attribute,
        )?.[1];
        if (!family) continue;
        let entry = stages.get(family);
        if (!entry) {
          entry = {
            stage: { facets: [], rotation: 0 },
            capacity: 1,
            counts: new Set([1]),
          };
          stages.set(family, entry);
        }
        this.prismFunctions.set(fn, entry.stage);
        if (fn.attribute === family && fn.wheel)
          for (const facets of this.prisms.get(fn.wheel) ?? []) {
            entry.capacity = Math.max(entry.capacity, facets.length);
            entry.counts.add(Math.max(1, facets.length));
          }
      }
    }
    let capacity = 1;
    for (const entry of stages.values()) {
      this.prismStages.push(entry.stage);
      capacity *= entry.capacity;
    }
    this.prismCapacityExceeded = capacity > MAX_PREPARED_FACETS;
    if (this.prismStages.length > 1 || this.prismCapacityExceeded) {
      this.maxFacetCount = Math.min(capacity, MAX_PREPARED_FACETS);
      let preparedCounts = new Set([1]);
      for (const entry of stages.values()) {
        const next = new Set<number>();
        for (const prior of preparedCounts)
          for (const count of entry.counts)
            next.add(Math.min(MAX_PREPARED_FACETS, prior * count));
        preparedCounts = next;
      }
      this.prismStack = new PrismStack(
        this.maxFacetCount,
        preparedCounts,
        true,
      );
    }
  }

  /** Resolves the current source function without fetching images or allocating per-frame state. */
  update(
    colors: ReadonlyMap<string, EmitterColor>,
    seconds = performance.now() / 1000,
  ): void {
    const delta =
      this.lastTime === undefined || !Number.isFinite(seconds)
        ? 0
        : Math.max(0, seconds - this.lastTime);
    if (Number.isFinite(seconds)) this.lastTime = seconds;
    for (const stage of this.gobos) {
      stage.slot = 0;
      stage.rotation = 0;
    }
    this.prism = undefined;
    this.prismRotation = 0;
    this.focusDistance = 0;
    this.zoomDegrees = undefined;
    for (const stage of this.prismStages) {
      stage.facets = EMPTY_FACETS;
      stage.rotation = 0;
    }
    for (const control of this.channels) {
      const { channel, state } = control;
      const values = colors.get(channel.geometry) as
        | (EmitterColor & Record<string, number | undefined>)
        | undefined;
      // Element DMX carries each parameter once, under its output key.
      evaluateOpticalChannel(
        channel,
        values?.[channel.parameterKey],
        state,
        colors,
      );
      if (state.status !== "resolved") continue;
      const attribute = state.function!.attribute;
      if (
        /^Zoom\d*$/.test(attribute) &&
        state.function!.physicalUnit === PhysicalUnit.Angle &&
        state.physical! > 0
      ) {
        this.zoomDegrees = state.physical!;
      }
      if (
        /^Focus\d*(Distance)?$/.test(attribute) &&
        state.function!.physicalUnit === PhysicalUnit.Length &&
        state.physical! > 0
      ) {
        this.focusDistance = state.physical!;
      }
      if (
        /^Gobo\d*$/.test(attribute) &&
        state.wheel &&
        state.wheelSlot !== undefined
      ) {
        const slot = this.wheels.get(state.wheel)?.[state.wheelSlot - 1];
        this.goboFunctions.get(state.function!)!.slot =
          slot?.status === "ready" ? slot.index : 0;
      } else if (/^Gobo\d*Pos$/.test(attribute)) {
        const rotation = control.rotations.get(state.function!)!;
        rotation.angle = (state.physical! * Math.PI) / 180;
        this.goboFunctions.get(state.function!)!.rotation = rotation.angle;
      } else if (/^Gobo\d*PosRotate$/.test(attribute)) {
        const rotation = control.rotations.get(state.function!)!;
        rotation.angle =
          (rotation.angle + (state.physical! * delta * Math.PI) / 180) %
          (Math.PI * 2);
        this.goboFunctions.get(state.function!)!.rotation = rotation.angle;
      } else if (
        /^Prism\d*$/.test(attribute) &&
        state.wheel &&
        state.wheelSlot !== undefined
      ) {
        const facets = this.prisms.get(state.wheel)?.[state.wheelSlot - 1];
        this.prism = facets?.length ? facets : undefined;
        this.prismFunctions.get(state.function!)!.facets =
          facets ?? EMPTY_FACETS;
      } else if (/^Prism\d*Pos$/.test(attribute)) {
        const rotation = control.rotations.get(state.function!)!;
        rotation.angle = (state.physical! * Math.PI) / 180;
        this.prismRotation = rotation.angle;
        this.prismFunctions.get(state.function!)!.rotation = rotation.angle;
      } else if (/^Prism\d*PosRotate$/.test(attribute)) {
        const rotation = control.rotations.get(state.function!)!;
        rotation.angle =
          (rotation.angle + (state.physical! * delta * Math.PI) / 180) %
          (Math.PI * 2);
        this.prismRotation = rotation.angle;
        this.prismFunctions.get(state.function!)!.rotation = rotation.angle;
      }
    }
    if (this.prismStack) {
      let requested = 1;
      for (const stage of this.prismStages)
        requested *= Math.max(1, stage.facets.length);
      this.prismReduced = requested > this.maxFacetCount;
      this.prism = this.prismStack.compose(this.prismStages);
      if (this.prism) this.prismRotation = 0;
    }
  }
}

const EMPTY_FACETS: readonly PrismProjection[] = [];
