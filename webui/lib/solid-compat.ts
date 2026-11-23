// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Solid 2.0 shaped reactive APIs implemented on Solid 1.x.
 *
 * Code written against this module already has the 2.0 call shape, so the 2.0
 * upgrade replaces these imports with `solid-js` instead of rewriting every
 * call site. Keep this module free of app imports: every web UI layer,
 * including `components/ui`, may depend on it.
 */

import {
  createEffect as createSolidEffect,
  onCleanup,
  untrack,
} from "solid-js";

/** Side effect half of a two-function effect; may return a cleanup. */
export type EffectFunction<Next, Prev = Next> = (
  value: Next,
  prev: Prev | undefined,
  // biome-ignore lint/suspicious/noConfusingVoidType: matches Solid 2.0's EffectFunction so void-returning handlers can be passed.
) => void | (() => void);

/** Options shared by the 1.x shim and Solid 2.0's `createEffect`. */
export type EffectOptions = {
  /** Skips the effect function on the first run; it first runs on a change. */
  defer?: boolean;
};

/**
 * Runs a side effect whenever the values read by `compute` change.
 *
 * `compute` is tracked and should only read reactive state and return what
 * the effect needs. `effect` receives that value and the previous one, runs
 * untracked so nothing it reads becomes a dependency, and may return a
 * cleanup that runs before the next run and when the owner is disposed.
 *
 * This matches Solid 2.0's two-function `createEffect`: `effect` only runs
 * when `compute` returns a different value (by `===`), so a compute that
 * returns a fresh array or object runs it on every change of its inputs.
 * Return a cleanup instead of calling `onCleanup` inside `effect`. Derived
 * values belong in `createMemo`, not in an effect that sets a signal.
 *
 * The one-function overload forwards to Solid 1.x's `createEffect` so that a
 * file can import a single `createEffect` while its effects are converted.
 */
export function createEffect<Next>(
  compute: (prev: Next | undefined) => Next,
  effect: EffectFunction<Next>,
  options?: EffectOptions,
): void;
/** @deprecated One-function effects go away in Solid 2.0; pass `compute` and `effect` instead. */
export function createEffect(fn: () => void): void;
export function createEffect<Next>(
  compute: (prev: Next | undefined) => Next,
  effect?: EffectFunction<Next>,
  options?: EffectOptions,
): void {
  if (!effect) {
    /** Runs a one-function effect unchanged on Solid 1.x. */
    createSolidEffect(() => {
      compute(undefined);
    });
    return;
  }

  let initialized = false;
  let previous: Next | undefined;
  // Owned here rather than by the inner computation, so a compute rerun that
  // returns the same value keeps the last run's cleanup in place.
  let cleanup: (() => void) | undefined;
  onCleanup(() => cleanup?.());

  /** Tracks `compute`, then runs `effect` untracked when its value changed. */
  createSolidEffect(() => {
    const value = compute(previous);
    untrack(() => {
      const prev = previous;
      previous = value;
      if (!initialized) {
        initialized = true;
        if (options?.defer) return;
      } else if (value === prev) {
        return;
      }
      cleanup?.();
      const next = effect(value, prev);
      cleanup = typeof next === "function" ? next : undefined;
    });
  });
}
