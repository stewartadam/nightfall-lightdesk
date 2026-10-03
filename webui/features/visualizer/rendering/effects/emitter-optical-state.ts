// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  OpticalFunctionKind,
  type ParameterFunction,
  type PrismFacet,
} from "../../../../types";
import type { EmitterData } from "../../model/types";
import type { EmitterColor } from "../geometry-builder";
import {
  type OpticalReadoutKeys,
  opticalReadoutKeys,
} from "../optical-readouts";
import type { GoboAtlasSlot } from "./gobo-atlas";
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

const EMPTY_FACETS: readonly PrismProjection[] = [];

/** Orientation of one wheel, shared by its indexed and continuous rotation functions. */
interface WheelRotation {
  angle: number;
}

/** What one profile function does to the optical path while it is active. */
type OpticalRole =
  | { kind: "zoom" }
  | { kind: "focus" }
  | {
      kind: "gobo";
      stage: GoboStage;
      /** Atlas slot of each channel set's image, indexed like `fn.sets`. */
      slots: readonly (GoboAtlasSlot | undefined)[];
    }
  | {
      kind: "goboRotation";
      stage: GoboStage;
      rotation: WheelRotation;
      continuous: boolean;
    }
  | {
      kind: "prism";
      stage: PrismStage;
      /** Compiled facets of each channel set, indexed like `fn.sets`. */
      facets: readonly (readonly PrismProjection[])[];
    }
  | {
      kind: "prismRotation";
      stage: PrismStage;
      rotation: WheelRotation;
      continuous: boolean;
    };

/** One bound optical parameter: where its evaluated channel is read and what each function does. */
interface OpticalControl {
  /** Label of the element whose DMX record carries the readouts. */
  element: string;
  readout: OpticalReadoutKeys;
  /** Role of each profile function, indexed like `parameter.functions`. */
  roles: (OpticalRole | undefined)[];
}

/** Collected prism stage with the facet counts its sets can select. */
interface PrismFamily {
  stage: PrismStage;
  capacity: number;
  counts: Set<number>;
}

/**
 * Compiles an aperture's inherited optical parameters and wheel images once,
 * then updates only numeric optical state from the channels develop's fixture
 * evaluator resolved: the active function's attribute and unit, its channel
 * set's image or prism facets, and its physical value.
 */
export class EmitterOpticalState implements ApertureControls {
  readonly gobos: GoboStage[] = [];
  prism: readonly PrismProjection[] | undefined;
  prismRotation = 0;
  focusDistance = 0;
  zoomDegrees: number | undefined;
  maxFacetCount = 1;
  private readonly controls: OpticalControl[] = [];
  private lastTime: number | undefined;
  private readonly prismStages: PrismStage[] = [];
  private readonly prismStack: PrismStack | undefined;
  /** Explicitly reports fixtures whose prepared prism product exceeds the rendering budget. */
  readonly prismCapacityExceeded: boolean;
  /** True only while the current DMX-selected split is being approximated. */
  prismReduced = false;
  /** Archive and media names of every image this aperture acquired, for {@link releaseGobos}. */
  private readonly heldGobos: {
    path: string;
    revision: string | undefined;
    media: string[];
  };

  /** Preloads the images of every gobo slot the aperture's parameters can select, before playback begins. */
  constructor(
    emitter: EmitterData,
    load: (path: string, media: string, revision?: string) => GoboAtlasSlot,
  ) {
    this.heldGobos = {
      path: emitter.gdtfPath ?? "",
      revision: emitter.gdtfRevision,
      media: [],
    };
    const goboFamilies = new Map<
      string,
      { number: number; stage: GoboStage }
    >();
    const prismFamilies = new Map<string, PrismFamily>();
    const rotations = new Map<string, WheelRotation>();
    const loaded = new Map<string, GoboAtlasSlot>();
    const loadMedia = (media: string | undefined) => {
      if (!media || !emitter.gdtfPath) return undefined;
      let slot = loaded.get(media);
      if (!slot) {
        slot = load(emitter.gdtfPath, media, emitter.gdtfRevision);
        loaded.set(media, slot);
        this.heldGobos.media.push(media);
      }
      return slot;
    };
    const goboStage = (key: string, number: number) => {
      let family = goboFamilies.get(key);
      if (!family) {
        family = { number, stage: { slot: 0, rotation: 0 } };
        goboFamilies.set(key, family);
      }
      return family.stage;
    };
    const prismFamily = (key: string) => {
      let family = prismFamilies.get(key);
      if (!family) {
        family = {
          stage: { facets: EMPTY_FACETS, rotation: 0 },
          capacity: 1,
          counts: new Set([1]),
        };
        prismFamilies.set(key, family);
      }
      return family;
    };
    const rotation = (key: string) => {
      let wheel = rotations.get(key);
      if (!wheel) {
        wheel = { angle: 0 };
        rotations.set(key, wheel);
      }
      return wheel;
    };
    /** Builds a function's render role from the optical meaning the backend classified. */
    const role = (fn: ParameterFunction): OpticalRole | undefined => {
      const optical = fn.optical;
      if (!optical) return undefined;
      const gobo = `Gobo${optical.wheel}`;
      const prism = `Prism${optical.wheel}`;
      switch (optical.kind) {
        case OpticalFunctionKind.Zoom:
          return { kind: "zoom" };
        case OpticalFunctionKind.Focus:
          return { kind: "focus" };
        case OpticalFunctionKind.GoboIndex:
        case OpticalFunctionKind.GoboRotate:
          return {
            kind: "goboRotation",
            stage: goboStage(gobo, optical.wheel),
            rotation: rotation(gobo),
            continuous: optical.kind === OpticalFunctionKind.GoboRotate,
          };
        case OpticalFunctionKind.GoboSelect: {
          // Only slots with an image project.
          const slots = (fn.sets ?? []).map((set) => loadMedia(set.media));
          return slots.some(Boolean)
            ? { kind: "gobo", stage: goboStage(gobo, optical.wheel), slots }
            : undefined;
        }
        case OpticalFunctionKind.PrismIndex:
        case OpticalFunctionKind.PrismRotate:
          return {
            kind: "prismRotation",
            stage: prismFamily(prism).stage,
            rotation: rotation(prism),
            continuous: optical.kind === OpticalFunctionKind.PrismRotate,
          };
        case OpticalFunctionKind.PrismSelect: {
          const entry = prismFamily(prism);
          const facets = (fn.sets ?? []).map((set) =>
            compileFacets(set.facets),
          );
          for (const split of facets) {
            this.maxFacetCount = Math.max(this.maxFacetCount, split.length);
            entry.capacity = Math.max(entry.capacity, split.length);
            entry.counts.add(Math.max(1, split.length));
          }
          return { kind: "prism", stage: entry.stage, facets };
        }
      }
    };

    for (const { element, parameterIndex } of emitter.opticalParameters ?? []) {
      const readout = opticalReadoutKeys(element)[parameterIndex];
      if (!readout) continue;
      const functions = element.parameters[parameterIndex].functions ?? [];
      const roles = functions.map(role);
      if (roles.some(Boolean))
        this.controls.push({ element: element.label, readout, roles });
    }

    // Masks stack in wheel order, whatever order the channels were declared in.
    for (const { stage } of [...goboFamilies.values()].sort(
      (a, b) => a.number - b.number,
    ))
      this.gobos.push(stage);

    let capacity = 1;
    for (const entry of prismFamilies.values()) {
      this.prismStages.push(entry.stage);
      capacity *= entry.capacity;
    }
    this.prismCapacityExceeded = capacity > MAX_PREPARED_FACETS;
    if (this.prismStages.length > 1 || this.prismCapacityExceeded) {
      this.maxFacetCount = Math.min(capacity, MAX_PREPARED_FACETS);
      let preparedCounts = new Set([1]);
      for (const entry of prismFamilies.values()) {
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

  /**
   * Hands back every image acquired at construction, once, when the aperture is retired so the
   * shared atlas can reuse tiles no other aperture holds.
   */
  releaseGobos(
    release: (path: string, media: string, revision?: string) => void,
  ): void {
    const { path, revision, media } = this.heldGobos;
    for (const name of media) release(path, name, revision);
    media.length = 0;
  }

  /**
   * Resolves the active functions from the element records without fetching
   * images or allocating per-frame state. Controls whose element has no record
   * or no active function leave the aperture open, unzoomed and unsplit.
   */
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
    for (const control of this.controls) {
      const record = colors.get(control.element) as
        | Record<string, number | undefined>
        | undefined;
      const functionIndex = record?.[control.readout.function];
      if (functionIndex === undefined || functionIndex < 0) continue;
      const role = control.roles[functionIndex];
      if (!role) continue;
      const setIndex = record?.[control.readout.set] ?? -1;
      const physical = record?.[control.readout.physical] ?? Number.NaN;
      switch (role.kind) {
        case "zoom":
          // Profiles may end a zoom range at or below zero; the renderer floors the cone.
          if (Number.isFinite(physical)) this.zoomDegrees = physical;
          break;
        case "focus":
          if (physical > 0) this.focusDistance = physical;
          break;
        case "gobo": {
          const slot = role.slots[setIndex];
          role.stage.slot = slot?.status === "ready" ? slot.index : 0;
          break;
        }
        case "goboRotation":
          role.stage.rotation = rotate(role, physical, delta);
          break;
        case "prism": {
          const facets = role.facets[setIndex];
          this.prism = facets?.length ? facets : undefined;
          role.stage.facets = facets ?? EMPTY_FACETS;
          break;
        }
        case "prismRotation":
          this.prismRotation = rotate(role, physical, delta);
          role.stage.rotation = this.prismRotation;
          break;
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

/**
 * Advances a wheel's orientation: an indexed function sets it from degrees,
 * a continuous one turns it by degrees per second over the elapsed time.
 */
function rotate(
  role: { rotation: WheelRotation; continuous: boolean },
  physical: number,
  delta: number,
): number {
  if (!Number.isFinite(physical)) return role.rotation.angle;
  role.rotation.angle = role.continuous
    ? (role.rotation.angle + (physical * delta * Math.PI) / 180) % (Math.PI * 2)
    : (physical * Math.PI) / 180;
  return role.rotation.angle;
}

/** Compiles a channel set's prism facets, dropping degenerate ones. */
function compileFacets(
  facets: readonly PrismFacet[] | undefined,
): readonly PrismProjection[] {
  if (!facets?.length) return EMPTY_FACETS;
  return facets
    .map(compilePrismFacet)
    .filter((facet): facet is PrismProjection => facet !== undefined);
}
