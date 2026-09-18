// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Component, createMemo } from "solid-js";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Lightweight SVG sparkline component for inline metric visualization.
 * Auto-scales Y axis to data min/max range.
 */
export const Sparkline: Component<SparklineProps> = (props) => {
  const width = () => props.width ?? 100;

  const height = () => props.height ?? 24;

  const color = () => props.color ?? "#4ade80";

  const path = createMemo(() => {
    const values = props.data;
    if (values.length < 2) return "";

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const w = width();
    const h = height();
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 2) - 1; // 1px padding top/bottom
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return `M ${points.join(" L ")}`;
  });

  return (
    <svg
      width={width()}
      height={height()}
      class="inline-block align-middle"
      role="img"
      aria-label="Metric trend sparkline"
    >
      <path d={path()} fill="none" stroke={color()} stroke-width="1.5" />
    </svg>
  );
};
