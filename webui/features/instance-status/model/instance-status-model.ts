// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToMs, formatElapsedTime } from "../../../lib/time-format";
import {
  InstanceDisplayKind,
  type InstanceDisplayKind as InstanceDisplayKindType,
  type InstanceInfo,
} from "../../../types";
export type InstanceSortColumn =
  | "kind"
  | "instance"
  | "state"
  | "clip"
  | "owners"
  | "priority"
  | "position"
  | "intensity"
  | "rate"
  | "tags";
export type SortDirection = "asc" | "desc";
export type InstanceSortLabels = {
  clipLabel: (clipId: number | null | undefined) => string;
  ownerLabels: (instance: StatusInstanceInfo) => string;
};
export type StatusInstanceInfo = InstanceInfo & {
  is_paused?: boolean;
  owner_uids?: unknown[];
  priority?: number;
  activation_epoch_ms?: number;
};

export function instanceKindClass(kind: InstanceDisplayKindType): string {
  switch (kind) {
    case InstanceDisplayKind.Cue:
      return "bg-cyan-500/20 text-cyan-200 ring-cyan-400/30";
    case InstanceDisplayKind.Sequence:
      return "bg-sky-500/20 text-sky-200 ring-sky-400/30";
    case InstanceDisplayKind.Fx:
      return "bg-purple-500/20 text-purple-200 ring-purple-400/30";
    case InstanceDisplayKind.StepFx:
      return "bg-fuchsia-500/20 text-fuchsia-100 ring-fuchsia-400/30";
    case InstanceDisplayKind.FlowFx:
      return "bg-violet-500/20 text-violet-100 ring-violet-400/30";
    case InstanceDisplayKind.ModuleFx:
      return "bg-indigo-500/20 text-indigo-100 ring-indigo-400/30";
    case InstanceDisplayKind.Programmer:
      return "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30";
    default:
      return "bg-neutral-600/30 text-neutral-200 ring-neutral-500/40";
  }
}

export function instanceKindLabel(kind: InstanceDisplayKindType): string {
  switch (kind) {
    case InstanceDisplayKind.Cue:
      return "Cue";
    case InstanceDisplayKind.Fx:
      return "FX";
    case InstanceDisplayKind.StepFx:
      return "Step FX";
    case InstanceDisplayKind.FlowFx:
      return "Flow FX";
    case InstanceDisplayKind.ModuleFx:
      return "Module FX";
    default:
      return kind;
  }
}

/**
 * Shortens long backend IDs for dense status table cells.
 */
export function compactId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Normalizes UUID values that may arrive as strings or CBOR-decoded byte arrays.
 */
export function normalizeUid(uid: unknown): string | null {
  if (typeof uid === "string") {
    const normalized = uid.replace(/-/g, "").toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  if (uid instanceof Uint8Array) {
    if (uid.length !== 16) {
      return null;
    }
    return Array.from(uid)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  return null;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Returns a dense status label for a instance row. */
export function instanceStateLabel(instance: StatusInstanceInfo): string {
  if (instance.is_releasing)
    return instance.is_paused ? "Paused release" : "Releasing";
  return instance.is_paused ? "Paused" : "Running";
}

/** Returns visual classes for a instance state badge. */
export function instanceStateClass(instance: StatusInstanceInfo): string {
  if (instance.is_releasing) {
    return instance.is_paused
      ? "bg-amber-500/20 text-amber-100 ring-amber-400/30"
      : "bg-orange-500/20 text-orange-100 ring-orange-400/30";
  }
  if (instance.is_paused) {
    return "bg-yellow-500/20 text-yellow-100 ring-yellow-400/30";
  }
  return "bg-emerald-500/20 text-emerald-100 ring-emerald-400/30";
}

export function formatPartCount(count: number | null | undefined): string {
  if (!count) {
    return "";
  }
  return `${count} part${count === 1 ? "" : "s"}`;
}

export function appendPartCount(
  label: string,
  count: number | null | undefined,
): string {
  const partCount = formatPartCount(count);
  return partCount ? `${label} (${partCount})` : label;
}

export function formatInstancePosition(instance: InstanceInfo): string {
  const position = instance.status.position;

  switch (position.type) {
    case "Sequence": {
      const current =
        position.data.current_position > 0
          ? `${position.data.current_position}/${position.data.cue_count}`
          : "No cues";
      const label = position.data.current_label
        ? `${current} ${position.data.current_label}`
        : current;
      return appendPartCount(label, position.data.current_part_count);
    }
    case "Time":
      return formatElapsedTime(durationToMs(position.data.elapsed));
    case "None":
      return "-";
  }
}

export function formatInstanceNext(instance: InstanceInfo): string {
  const position = instance.status.position;
  if (
    position.type !== "Sequence" ||
    position.data.next_position === undefined ||
    position.data.next_position === null
  ) {
    return "";
  }

  const label = position.data.next_label ? ` ${position.data.next_label}` : "";
  return appendPartCount(
    `Next ${position.data.next_position}${label}`,
    position.data.next_part_count,
  );
}

/** Compares instance rows using operator-facing projected values. */
export function compareStatusInstanceRows(
  left: StatusInstanceInfo,
  right: StatusInstanceInfo,
  column: InstanceSortColumn,
  direction: SortDirection,
  labels: InstanceSortLabels,
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  /** Compares two labels using the requested direction. */
  const stringCompare = (leftValue: string, rightValue: string) =>
    leftValue.localeCompare(rightValue) * multiplier;
  /** Compares two numbers using the requested direction. */
  const numberCompare = (leftValue: number, rightValue: number) =>
    (leftValue - rightValue) * multiplier;

  switch (column) {
    case "kind":
      return stringCompare(left.display_kind, right.display_kind);
    case "instance":
      return stringCompare(left.name ?? "", right.name ?? "");
    case "state":
      return stringCompare(instanceStateLabel(left), instanceStateLabel(right));
    case "clip":
      return stringCompare(
        labels.clipLabel(left.bound_clip_id),
        labels.clipLabel(right.bound_clip_id),
      );
    case "owners":
      return stringCompare(labels.ownerLabels(left), labels.ownerLabels(right));
    case "priority": {
      const priorityResult = numberCompare(
        left.priority ?? Number.NEGATIVE_INFINITY,
        right.priority ?? Number.NEGATIVE_INFINITY,
      );
      if (priorityResult !== 0) return priorityResult;
      return (left.activation_epoch_ms ?? 0) - (right.activation_epoch_ms ?? 0);
    }
    case "position":
      return stringCompare(
        formatInstancePosition(left),
        formatInstancePosition(right),
      );
    case "intensity":
      return numberCompare(left.intensity_scale, right.intensity_scale);
    case "rate":
      return numberCompare(left.effective_rate, right.effective_rate);
    case "tags":
      return stringCompare(left.tags.join(","), right.tags.join(","));
  }
}
