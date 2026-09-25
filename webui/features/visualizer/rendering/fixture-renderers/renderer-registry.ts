// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Renderer registry for Visualizer.
 * Selects the appropriate specialized renderer based on fixture characteristics.
 *
 * Renderer selection priority:
 * 1. Explicit specialized fixtures (by make/model matching)
 * 2. LED bar (by geometry analysis - linear beam arrangement with 8+ pixels)
 * 3. Default GDTF geometry builder (fallback for all other fixtures)
 */

import type {
  BeamType,
  FixtureElement,
  FixtureGeometry,
  FixtureLayout,
  FixturePhysical,
} from "../../../../types";
import type { FixtureInstance } from "../../model/types";
import type { VisualizerQualityPreset } from "../../state/settings";
import {
  EMITTER_RADIANCE,
  UNBLOOMED_EMITTER_RADIANCE,
} from "../emitter-radiance";
import { buildGeometryTree, disposeFixtureInstance } from "../geometry-builder";
import {
  buildSimpleLedBar,
  disposeLedBar,
  isSimpleLedBar,
  type LedBarData,
  updateLedBarColors,
} from "./led-bar-renderer";
import {
  buildMovingHeadFixture,
  disposeMovingHead,
  type MovingHeadData,
  updateMovingHeadColors,
} from "./moving-head-renderer";
import {
  buildRotatingWashBeamFixture,
  disposeRotatingWashBeam,
  type RotatingWashBeamData,
  updateRotatingWashBeamColors,
} from "./rotating-wash-beam-renderer";
import {
  buildRgbStrobeBarFixture,
  buildStrobePanelFixture,
  disposeStrobePanel,
  type StrobePanelData,
  updateStrobePanelColors,
} from "./strobe-renderer";

/**
 * Renderer type identifiers.
 */
export type RendererType =
  | "led-bar"
  | "strobe-panel"
  | "moving-head"
  | "rotating-wash-beam"
  | "gdtf";

/**
 * Extended fixture instance that may include specialized renderer data.
 */
export type ExtendedFixtureInstance = FixtureInstance & {
  rendererType: RendererType;
  /** Physical layout used to construct this instance. */
  layout?: FixtureLayout;
  /** Photometry revision used when deciding whether fixture resources need rebuilding. */
  physicalSignature?: string;
  ledBarData?: LedBarData;
  strobePanelData?: StrobePanelData;
  movingHeadData?: MovingHeadData;
  rotatingWashBeamData?: RotatingWashBeamData;
  /** Beam type from fixture physical data */
  beamType?: BeamType;
  /** Element labels by one-based fixture element index. */
  elementLabels?: string[];
  /** GDTF geometry data for pan/tilt axis lookups */
  geometry?: FixtureGeometry;
};

/**
 * Determine the appropriate renderer type for a fixture.
 */
export function detectRendererType(layout?: FixtureLayout): RendererType {
  switch (layout) {
    case "strobe-matrix":
    case "rgb-strobe-bar":
      return "strobe-panel";
    case "rotating-wash-beam":
    case "linear-wash-bar":
      return "rotating-wash-beam";
    case "moving-head":
      return "moving-head";
    case "led-bar":
      return "led-bar";
    default:
      return "gdtf";
  }
}

/** Scales HDR emitter faces so presets rendered without bloom keep them readable. */
function emitterDisplayGain(quality: VisualizerQualityPreset): number {
  return quality === "high" ? 1 : UNBLOOMED_EMITTER_RADIANCE / EMITTER_RADIANCE;
}

/**
 * Build a fixture instance using the appropriate renderer.
 */
export function buildFixtureWithRenderer(
  fixtureUid: string,
  geometry: FixtureGeometry,
  elements: FixtureElement[],
  beamType?: BeamType,
  beamQuality: VisualizerQualityPreset = "high",
  layout?: FixtureLayout,
  physical?: FixturePhysical,
): ExtendedFixtureInstance {
  const rendererType = detectRendererType(layout);
  const displayGain = emitterDisplayGain(beamQuality);

  switch (rendererType) {
    case "led-bar": {
      const instance = buildSimpleLedBar(
        fixtureUid,
        elements,
        physical,
        displayGain,
      );
      return {
        ...instance,
        rendererType: "led-bar",
        beamType,
        elementLabels: elements.map((element) => element.label),
      };
    }

    case "strobe-panel": {
      const instance =
        layout === "rgb-strobe-bar"
          ? buildRgbStrobeBarFixture(fixtureUid, elements, displayGain)
          : buildStrobePanelFixture(fixtureUid, elements, displayGain);
      return {
        ...instance,
        rendererType: "strobe-panel",
        beamType,
        elementLabels: elements.map((element) => element.label),
      };
    }

    case "rotating-wash-beam": {
      const instance = buildRotatingWashBeamFixture(
        fixtureUid,
        elements,
        layout === "linear-wash-bar" ? 10 : 12,
        physical,
      );
      return {
        ...instance,
        rendererType: "rotating-wash-beam",
        beamType,
        elementLabels: elements.map((element) => element.label),
      };
    }

    case "moving-head": {
      const instance = buildMovingHeadFixture(
        fixtureUid,
        elements,
        geometry,
        physical,
      );
      return {
        ...instance,
        rendererType: "moving-head",
        beamType,
        elementLabels: elements.map((element) => element.label),
      };
    }

    default: {
      const instance = buildGeometryTree(fixtureUid, geometry);
      return {
        ...instance,
        rendererType: "gdtf",
        beamType,
        elementLabels: elements.map((element) => element.label),
        geometry,
      };
    }
  }
}

/**
 * Build a fixture without GDTF geometry using element data.
 * Returns null if no appropriate renderer is available.
 */
export function buildFixtureWithoutGeometry(
  fixtureUid: string,
  elements: FixtureElement[],
  beamType?: BeamType,
  beamQuality: VisualizerQualityPreset = "high",
  layout?: FixtureLayout,
  physical?: FixturePhysical,
): ExtendedFixtureInstance | null {
  const displayGain = emitterDisplayGain(beamQuality);
  if (layout === "rgb-strobe-bar") {
    const instance = buildRgbStrobeBarFixture(
      fixtureUid,
      elements,
      displayGain,
    );
    return {
      ...instance,
      rendererType: "strobe-panel",
      beamType,
      elementLabels: elements.map((element) => element.label),
    };
  }

  if (layout === "rotating-wash-beam" || layout === "linear-wash-bar") {
    const instance = buildRotatingWashBeamFixture(
      fixtureUid,
      elements,
      layout === "linear-wash-bar" ? 10 : 12,
      physical,
    );
    return {
      ...instance,
      rendererType: "rotating-wash-beam",
      beamType,
      elementLabels: elements.map((element) => element.label),
    };
  }

  // Explicit layouts render without imported geometry.
  if (layout === "strobe-matrix") {
    const instance = buildStrobePanelFixture(fixtureUid, elements, displayGain);
    return {
      ...instance,
      rendererType: "strobe-panel",
      beamType,
      elementLabels: elements.map((element) => element.label),
    };
  }

  // Imported fixtures without geometry can expose pan through their parameters.
  if (
    layout === "moving-head" ||
    elements.some((element) =>
      element.parameters.some(
        (parameter) => parameter.attribute.type === "Pan",
      ),
    )
  ) {
    const instance = buildMovingHeadFixture(
      fixtureUid,
      elements,
      undefined,
      physical,
    );
    return {
      ...instance,
      rendererType: "moving-head",
      beamType,
      elementLabels: elements.map((element) => element.label),
    };
  }

  // Check if this is a simple LED bar (8+ RGB elements)
  if (layout === "led-bar" || isSimpleLedBar(elements)) {
    const instance = buildSimpleLedBar(
      fixtureUid,
      elements,
      physical,
      displayGain,
    );
    return {
      ...instance,
      rendererType: "led-bar",
      beamType,
      elementLabels: elements.map((element) => element.label),
    };
  }

  // No renderer available for this fixture type
  return null;
}

/**
 * Update fixture emitter/pixel colors using the appropriate renderer.
 * @param elementColors Map with element labels as keys
 */
export function updateFixtureColors(
  instance: ExtendedFixtureInstance,
  elementColors: Map<
    string,
    {
      red: number;
      green: number;
      blue: number;
      intensity: number;
      tilt?: number;
      tiltSpeed?: number;
      pan?: number;
      zoom?: number;
      frost?: number;
      white?: number;
    }
  >,
): void {
  switch (instance.rendererType) {
    case "led-bar":
      if (instance.ledBarData) {
        updateLedBarColors(
          instance as FixtureInstance & { ledBarData: LedBarData },
          elementColors,
        );
      }
      break;

    case "strobe-panel":
      if (instance.strobePanelData) {
        updateStrobePanelColors(
          instance as FixtureInstance & { strobePanelData: StrobePanelData },
          elementColors,
        );
      }
      break;

    case "moving-head":
      if (instance.movingHeadData) {
        updateMovingHeadColors(
          instance as FixtureInstance & { movingHeadData: MovingHeadData },
          elementColors,
        );
      }
      break;

    case "rotating-wash-beam":
      if (instance.rotatingWashBeamData) {
        updateRotatingWashBeamColors(
          instance as FixtureInstance & {
            rotatingWashBeamData: RotatingWashBeamData;
          },
          elementColors,
        );
      }
      break;

    default:
      // GDTF renderer color updates are applied by geometry-builder when the
      // visualizer refreshes fixture element colors.
      break;
  }
}

/**
 * Dispose fixture resources using the appropriate renderer.
 */
export function disposeFixtureWithRenderer(
  instance: ExtendedFixtureInstance,
): void {
  switch (instance.rendererType) {
    case "led-bar":
      if (instance.ledBarData) {
        disposeLedBar(instance as FixtureInstance & { ledBarData: LedBarData });
      }
      break;

    case "strobe-panel":
      if (instance.strobePanelData) {
        disposeStrobePanel(
          instance as FixtureInstance & { strobePanelData: StrobePanelData },
        );
      }
      break;

    case "moving-head":
      if (instance.movingHeadData) {
        disposeMovingHead(
          instance as FixtureInstance & { movingHeadData: MovingHeadData },
        );
      }
      break;

    case "rotating-wash-beam":
      if (instance.rotatingWashBeamData) {
        disposeRotatingWashBeam(
          instance as FixtureInstance & {
            rotatingWashBeamData: RotatingWashBeamData;
          },
        );
      }
      break;

    default:
      disposeFixtureInstance(instance);
      break;
  }
}
