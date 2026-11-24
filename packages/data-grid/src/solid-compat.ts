// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The Solid 2.0 shaped effect APIs the grid uses, implemented on Solid 1.x.
 *
 * Grid code written against this module already has the 2.0 call shape, so
 * the Solid 2.0 upgrade replaces these imports with `solid-js` instead of
 * rewriting every call site.
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
 */
export function createEffect<Next>(
  compute: (prev: Next | undefined) => Next,
  effect: EffectFunction<Next>,
  options?: EffectOptions,
): void {
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

/**
 * Runs `fn` now and again whenever anything it reads changes, like a Solid
 * 1.x effect, and runs the cleanup it returns before each rerun and on
 * disposal.
 *
 * This matches Solid 2.0's `createTrackedEffect`. Use it only where the
 * reads can't be separated from the side effect, such as drawing through a
 * callback whose reactive inputs are unknown; prefer the two-function
 * `createEffect` everywhere else.
 */
export function createTrackedEffect(
  // biome-ignore lint/suspicious/noConfusingVoidType: matches Solid 2.0's createTrackedEffect so void-returning draws can be passed.
  fn: () => void | (() => void),
): void {
  /** Runs `fn` tracked and registers the cleanup it returns. */
  createSolidEffect(() => {
    const cleanup = fn();
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
}
