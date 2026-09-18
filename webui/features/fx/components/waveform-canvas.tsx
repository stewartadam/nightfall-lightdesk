// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { throttle } from "@solid-primitives/scheduled";
import { createMemo, createSignal } from "solid-js";
import type { FlowWaveform } from "../../../types";
import { generateSvgPathFromFlow } from "../model/waveform-utils";

export interface WaveformCanvasProps {
  /** The waveform configuration to visualize */
  waveform: FlowWaveform;
  /** Callback when phase is changed via horizontal drag */
  onPhaseChange: (phase: number) => void;
  /** Callback when amplitude is changed via vertical drag */
  onAmplitudeChange?: (amplitude: number) => void;

  /** Optional class name for the container */
  class?: string;
}

/**
 * SVG-based waveform visualization with drag interaction.
 * - Horizontal drag: shifts phase
 * - Vertical drag: adjusts amplitude
 * Uses Pointer Events API with setPointerCapture for reliable tracking.
 */
export function WaveformCanvas(props: WaveformCanvasProps) {
  let containerRef: HTMLDivElement | undefined;
  const [isDragging, setIsDragging] = createSignal(false);
  const [dragStartX, setDragStartX] = createSignal(0);
  const [dragStartY, setDragStartY] = createSignal(0);
  const [dragStartPhase, setDragStartPhase] = createSignal(0);
  const [dragStartAmplitude, setDragStartAmplitude] = createSignal(1);

  // Throttle callbacks to avoid excessive parent updates during drag (16ms = ~60fps)
  const throttledPhaseChange = throttle(
    (phase: number) => props.onPhaseChange(phase),
    16,
  );
  const throttledAmplitudeChange = throttle(
    (amplitude: number) => props.onAmplitudeChange?.(amplitude),
    16,
  );

  /** Generate the SVG path from waveform parameters */
  const waveformPath = createMemo(() => {
    return generateSvgPathFromFlow(props.waveform);
  });

  /** Get min/max values for display (as percentages) */
  const minMaxPercent = createMemo(() => {
    const base = props.waveform.base;
    const amplitude = props.waveform.amplitude;
    return {
      min: Math.round(base * 100),
      max: Math.round((base + amplitude) * 100),
    };
  });

  const handlePointerDown = (e: PointerEvent) => {
    // Only capture for mouse/pen - allow touch to scroll
    if (e.pointerType === "touch") return;

    setIsDragging(true);
    setDragStartX(e.clientX);
    setDragStartY(e.clientY);
    setDragStartPhase(props.waveform.phase);
    setDragStartAmplitude(props.waveform.amplitude);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging()) return;
    e.preventDefault();

    const deltaX = e.clientX - dragStartX();
    const deltaY = e.clientY - dragStartY();

    // Horizontal drag: phase shift
    const containerWidth = containerRef?.clientWidth ?? 300;
    const phaseShift = (deltaX / containerWidth) * 2 * Math.PI;
    let newPhase = dragStartPhase() + phaseShift;
    // Normalize to 0-2π range
    newPhase = ((newPhase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // Send throttled update to parent
    throttledPhaseChange(newPhase);

    // Vertical drag: amplitude (inverted - drag up to increase)
    if (props.onAmplitudeChange) {
      const containerHeight = containerRef?.clientHeight ?? 128;
      // Full height drag = 100% amplitude change
      const amplitudeDelta = -deltaY / containerHeight;
      let newAmplitude = dragStartAmplitude() + amplitudeDelta;
      // Clamp to 0.1-1.0 range
      newAmplitude = Math.max(0.1, Math.min(1.0, newAmplitude));

      // Send throttled update to parent
      throttledAmplitudeChange(newAmplitude);
    }
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (isDragging()) {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
  };

  return (
    <div
      ref={containerRef}
      class={`relative w-full h-32 bg-neutral-900 rounded ${props.class ?? ""}`}
      style={{
        cursor: isDragging() ? "grabbing" : "grab",
        "user-select": isDragging() ? "none" : "auto",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* SVG for waveform - uses viewBox with preserveAspectRatio="none" for stretching */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        class="absolute inset-0 w-full h-full"
      >
        {/* Center guide line (dashed) */}
        <line
          x1="0"
          y1="50"
          x2="100"
          y2="50"
          stroke="currentColor"
          stroke-width="0.5"
          stroke-dasharray="2,2"
          class="text-neutral-700"
        />

        {/* Waveform path */}
        <path
          d={waveformPath()}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="text-blue-500"
          vector-effect="non-scaling-stroke"
        />
      </svg>

      {/* HTML overlay for non-stretched text labels (percentages) */}
      <div class="absolute top-1 left-2 text-xs text-neutral-500">
        {minMaxPercent().max}%
      </div>
      <div class="absolute bottom-1 left-2 text-xs text-neutral-500">
        {minMaxPercent().min}%
      </div>
    </div>
  );
}
