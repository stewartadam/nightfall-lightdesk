// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ActionReference } from "../types";

/** Text names for argument-free tempo actions, keyed by registered action ID. */
const TRIGGER_ACTIONS = {
  TapTempo: "tempo.tap",
  ResyncTempo: "tempo.resync",
} as const;

/** Text names for tempo actions with one numeric argument, with the argument's key. */
const NUMERIC_ACTIONS = {
  SetTempo: { id: "tempo.set", argument: "bpm" },
  MultiplyTempo: { id: "tempo.multiply", argument: "factor" },
  NudgeTempo: { id: "tempo.nudge", argument: "beats" },
} as const;

/**
 * Formats a tempo action reference as mapping-table text, or returns
 * `undefined` when the reference is not a tempo action.
 */
export function formatTempoAction(action: ActionReference): string | undefined {
  for (const [name, id] of Object.entries(TRIGGER_ACTIONS)) {
    if (action.id === id) return name;
  }
  for (const [name, spec] of Object.entries(NUMERIC_ACTIONS)) {
    if (action.id !== spec.id) continue;
    const value = (action.arguments as Record<string, unknown> | null)?.[
      spec.argument
    ];
    return typeof value === "number" ? `${name}(${value})` : action.id;
  }
  return undefined;
}

/**
 * Parses mapping-table text such as `TapTempo` or `SetTempo(128)` into a
 * tempo action reference, or returns `undefined` for anything else.
 */
export function parseTempoAction(text: string): ActionReference | undefined {
  const trimmed = text.trim();
  if (trimmed in TRIGGER_ACTIONS) {
    return {
      id: TRIGGER_ACTIONS[trimmed as keyof typeof TRIGGER_ACTIONS],
      arguments: {},
    };
  }
  const match = trimmed.match(/^(\w+)\((-?\d+(?:\.\d+)?)\)$/);
  if (!match || !(match[1] in NUMERIC_ACTIONS)) return undefined;
  const spec = NUMERIC_ACTIONS[match[1] as keyof typeof NUMERIC_ACTIONS];
  return { id: spec.id, arguments: { [spec.argument]: Number(match[2]) } };
}
