// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, mergeProps } from "solid-js";
import {
  Input,
  InputGroup,
  InputSuffix,
} from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { useTimelineContext } from "../context/timeline-context";

export type ZoomControlsProps = {
  minZoom?: number;
  maxZoom?: number;
  stepFactor?: number;
};

const TIMELINE_MIN_ZOOM = 10;
const TIMELINE_MAX_ZOOM = 1000;
const TIMELINE_ZOOM_STEP_FACTOR = 1.1;

/** Increases zoom by one step within the configured maximum. */
export const zoomTimelineIn = (
  zoom: number,
  maxZoom = TIMELINE_MAX_ZOOM,
  stepFactor = TIMELINE_ZOOM_STEP_FACTOR,
) => Math.min((zoom || 100) * stepFactor, maxZoom);

/** Decreases zoom by one step within the configured minimum. */
export const zoomTimelineOut = (
  zoom: number,
  minZoom = TIMELINE_MIN_ZOOM,
  stepFactor = TIMELINE_ZOOM_STEP_FACTOR,
) => Math.max((zoom || 100) / stepFactor, minZoom);

const defaultProps = {
  minZoom: TIMELINE_MIN_ZOOM,
  maxZoom: TIMELINE_MAX_ZOOM,
  stepFactor: TIMELINE_ZOOM_STEP_FACTOR,
};

/** Provides bounded zoom steps and an editable zoom percentage. */
export const ZoomControls = (props: ZoomControlsProps) => {
  const context = useTimelineContext();
  const mprops = mergeProps(defaultProps, props);

  // Create signal to track the value during editing
  // It syncs with context.zoom when values are valid
  const [inputZoom, setInputZoom] = createSignal(
    Math.round(context.zoom()).toString(),
  );

  /** Synchronizes the editable percentage with external zoom changes. */
  createEffect(() => {
    setInputZoom(Math.round(context.zoom()).toString());
  });

  /** Applies the next larger zoom level. */
  const handleZoomIn = () => {
    const newZoom = zoomTimelineIn(
      context.zoom(),
      mprops.maxZoom,
      mprops.stepFactor,
    );
    context.setZoom(newZoom);
  };

  /** Applies the next smaller zoom level. */
  const handleZoomOut = () => {
    const newZoom = zoomTimelineOut(
      context.zoom(),
      mprops.minZoom,
      mprops.stepFactor,
    );
    context.setZoom(newZoom);
  };

  /** Publishes valid percentages while preserving partial input during editing. */
  const handleZoomChange = (e: InputEvent) => {
    const input = e.target as HTMLInputElement;
    setInputZoom(input.value);

    // Only update context zoom if value is valid
    const zoomValue = Number.parseInt(input.value, 10);
    if (
      !Number.isNaN(zoomValue) &&
      zoomValue >= mprops.minZoom &&
      zoomValue <= mprops.maxZoom
    ) {
      context.setZoom(zoomValue);
    }
  };

  /** Applies the next larger zoom level. */
  /** Restores the current zoom when editing ends with an invalid percentage. */
  const handleZoomInputBlur = () => {
    // Reset input to current zoom if invalid
    const zoomValue = Number.parseInt(inputZoom(), 10);
    if (
      Number.isNaN(zoomValue) ||
      zoomValue < mprops.minZoom ||
      zoomValue > mprops.maxZoom
    ) {
      setInputZoom(Math.round(context.zoom()).toString());
    }
  };

  return (
    <InputGroup class="timeline-zoom-controls shrink-0">
      <Button
        variant="subtle"
        size="compact"
        aria-label="Zoom out"
        onClick={handleZoomOut}
        disabled={context.zoom() <= mprops.minZoom}
      >
        −
      </Button>
      <Input
        density="compact"
        type="text"
        aria-label="Timeline zoom"
        value={inputZoom()}
        onInput={handleZoomChange}
        onBlur={handleZoomInputBlur}
        class="text-center"
      />
      <InputSuffix>%</InputSuffix>
      <Button
        variant="subtle"
        size="compact"
        aria-label="Zoom in"
        onClick={handleZoomIn}
        disabled={context.zoom() >= mprops.maxZoom}
      >
        +
      </Button>
    </InputGroup>
  );
};
