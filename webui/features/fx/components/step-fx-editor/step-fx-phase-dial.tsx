// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, For } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import type * as types from "../../../../types";
import { stepFxPhaseOffset } from "../../model/step-fx-editor-model";

/** Draws the authored selection offsets around one normalized cycle. */
export function StepFxPhaseDial(props: {
  phase: types.StepFxPhase;
  selectionCount: number;
}) {
  const directionRadius = 54;
  const directionMarkerId = `step-fx-phase-direction-${uuidv4()}`;
  /** Selects representative indexes without overcrowding the compact dial. */
  const indexes = createMemo(() => {
    const count = Math.max(1, props.selectionCount);
    const displayed = Math.min(count, 12);
    return Array.from({ length: displayed }, (_, index) =>
      Math.min(count - 1, Math.floor((index * count) / displayed)),
    );
  });
  /** Converts one normalized phase into dial coordinates. */
  const point = (phase: number, radius: number) => {
    const angle = phase * Math.PI * 2 - Math.PI / 2;
    return {
      x: 60 + Math.cos(angle) * radius,
      y: 60 + Math.sin(angle) * radius,
    };
  };
  /** Returns one displayed index's resolved phase. */
  const offsetFor = (index: number): number =>
    stepFxPhaseOffset(props.phase, index, Math.max(1, props.selectionCount));
  /** Returns the start pointer endpoint. */
  const startPoint = () => point(props.phase.waypoints[0] ?? 0, 35);
  /** Resolves the first authored movement as clockwise or counterclockwise. */
  const direction = (): -1 | 1 => {
    const start = props.phase.waypoints[0] ?? 0;
    const next = props.phase.waypoints
      .slice(1)
      .find((waypoint) => Math.abs(waypoint - start) > 0.000_001);
    return next !== undefined && next < start ? -1 : 1;
  };
  /** Draws a 45-degree directional arc around the outer edge of the black dial. */
  const directionArc = (): string => {
    const start = props.phase.waypoints[0] ?? 0;
    const from = point(start, directionRadius);
    const to = point(start + direction() / 8, directionRadius);
    return `M ${from.x} ${from.y} A ${directionRadius} ${directionRadius} 0 0 ${direction() > 0 ? 1 : 0} ${to.x} ${to.y}`;
  };

  return (
    <svg
      viewBox="0 0 120 120"
      class="size-32 rounded-full bg-neutral-950"
      role="img"
      aria-label={`Start position preview for ${Math.max(1, props.selectionCount)} selection indexes`}
    >
      <defs>
        <marker
          id={directionMarkerId}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgb(147 197 253)" />
        </marker>
      </defs>
      <circle
        cx="60"
        cy="60"
        r="44"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="text-neutral-700"
      />
      <path
        d={directionArc()}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        marker-end={`url(#${directionMarkerId})`}
        class="text-[var(--accent)]"
        data-step-fx-start-position-direction-radius={directionRadius}
        data-step-fx-start-position-direction={
          direction() > 0 ? "clockwise" : "counterclockwise"
        }
      />
      <line
        x1="60"
        y1="60"
        x2={startPoint().x}
        y2={startPoint().y}
        stroke="currentColor"
        stroke-width="2"
        class="text-[var(--accent)]"
      />
      <circle cx="60" cy="60" r="3" class="fill-[var(--accent)]" />
      <For each={indexes()}>
        {(index) => {
          /** Returns this marker's current dial position. */
          const marker = () => point(offsetFor(index), 44);
          return (
            <circle
              cx={marker().x}
              cy={marker().y}
              r="4"
              class={index === 0 ? "fill-amber-300" : "fill-sky-300"}
              stroke="rgb(23 23 23)"
              stroke-width="1.5"
              data-step-fx-start-position-marker={index}
            />
          );
        }}
      </For>
    </svg>
  );
}
