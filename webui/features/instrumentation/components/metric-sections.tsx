// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { formatNumber, type MetricTone } from "../model/metrics";
import "./metric-sections.css";

interface PipelineStepProps {
  label: string;
  value: unknown;
}

/** Type scale of a metric card value: `sm` for long text, `md` (default), `lg` and `xl` for headline numbers. */
export type MetricCardSize = "sm" | "md" | "lg" | "xl";

const METRIC_CARD_SIZE_CLASS: Record<MetricCardSize, string> = {
  sm: "text-sm",
  md: "text-lg",
  lg: "text-xl font-bold",
  xl: "text-2xl font-bold",
};

interface MetricCardProps {
  label: JSX.Element;
  value: JSX.Element;
  /** Value type scale. Defaults to `md`. */
  size?: MetricCardSize;
  /** Status color of the value. Defaults to `default`. */
  tone?: MetricTone;
}

/**
 * Renders a labeled instrumentation value in the shared metric-card
 * treatment. The value color comes only from `tone`, so a status such as a
 * slow frame rate always shows in its status color.
 */
export function MetricCard(props: MetricCardProps) {
  return (
    <div class="rounded-lg bg-neutral-800 p-3">
      <div class="mb-1 text-xs text-neutral-400">{props.label}</div>
      <MetricValue
        tone={props.tone}
        class={`block ${METRIC_CARD_SIZE_CLASS[props.size ?? "md"]}`}
      >
        {props.value}
      </MetricValue>
    </div>
  );
}

interface MetricValueProps {
  tone?: MetricTone;
  class?: string;
  children: JSX.Element;
}

/**
 * Renders an instrumentation value in the monospace font and its status tone.
 * Used by metric cards and by the compact readouts in section headers so both
 * color the same status identically.
 */
export function MetricValue(props: MetricValueProps) {
  return (
    <span
      class={`nf-metric-value font-mono ${props.class ?? ""}`.trim()}
      data-tone={props.tone ?? "default"}
    >
      {props.children}
    </span>
  );
}

interface MetricRowProps {
  label: string;
  value: JSX.Element;
}

/** Renders a compact label/value pair inside an instrumentation section. */
export function MetricRow(props: MetricRowProps) {
  return (
    <div class="flex items-center justify-between">
      <span class="text-sm text-neutral-300">{props.label}</span>
      <span class="font-mono text-sm text-white">{props.value}</span>
    </div>
  );
}

/** Renders one timed stage in the visualizer rendering pipeline. */
export function PipelineStep(props: PipelineStepProps) {
  return (
    <div class="flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1">
      <span class="text-xs text-neutral-400">{props.label}</span>
      <span class="font-mono text-xs">
        {formatNumber(props.value, 2, " ms")}
      </span>
    </div>
  );
}
