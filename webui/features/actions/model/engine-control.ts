// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/**
 * A UI control and its controller binding, defined once per target by the owning domain.
 *
 * The action a MIDI or OSC control binds to and the handlers that operate the control from
 * the UI derive from the same captured target arguments, so a button and its binding can't
 * address different targets. Handlers keep the UI's own execution path, such as one undo
 * entry per fader drag, while the bound action keeps the controller semantics.
 *
 * An engine control is a valid mapping choice for `Mappable` as is.
 */
export interface EngineControl<Handlers = Record<string, never>> {
  /** Label offered when choosing how to map the control. */
  readonly label: string;
  /** Detached copy of the bound action; editing it cannot redirect the control. */
  readonly action: types.ActionReference;
  /** Behaviors offered when mapping; defaults to every behavior the action supports. */
  readonly behaviors?: types.ControlBehavior[];
  /** Operates the same target from the UI. */
  readonly handlers: Handlers;
}

/** Everything a domain states to define one engine control. */
export interface EngineControlDefinition<
  Args extends Record<string, unknown>,
  Handlers,
> {
  /** Stable ID of the bound action. */
  id: string;
  /** Label offered when choosing how to map the control. */
  label: string;
  /** Target arguments shared by the bound action and the handlers. */
  args: Args;
  /** Behaviors offered when mapping; omit to offer every behavior the action supports. */
  behaviors?: types.ControlBehavior[];
  /** Builds the UI handlers for the captured target; omit for mapping-only choices. */
  handlers?: (args: Args) => Handlers;
}

/**
 * Captures a control's target arguments once and derives its bound action and handlers.
 *
 * Arguments are copied at definition time, and each read of `action` returns a fresh copy,
 * so neither callers nor mapping editors can change what the handlers operate.
 */
export function defineEngineControl<
  Args extends Record<string, unknown>,
  Handlers = Record<string, never>,
>(
  definition: EngineControlDefinition<Args, Handlers>,
): EngineControl<Handlers> {
  const captured = structuredClone(definition.args);
  return {
    label: definition.label,
    get action(): types.ActionReference {
      return { id: definition.id, arguments: structuredClone(captured) };
    },
    behaviors: definition.behaviors,
    handlers:
      definition.handlers?.(structuredClone(captured)) ?? ({} as Handlers),
  };
}
