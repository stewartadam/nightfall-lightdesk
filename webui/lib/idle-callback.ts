// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Provides a small, browser-safe wrapper around `requestIdleCallback`.
 *
 * The module preserves the native API when the host implements it and falls
 * back to a short `setTimeout`-based approximation otherwise. The fallback
 * exposes an `IdleDeadline`-like object so callers can schedule low-priority
 * work without depending on browser support for the real idle callback APIs.
 */
export interface IdleDeadlineLike {
  /** Indicates whether the callback ran because a timeout elapsed. */
  didTimeout: boolean;
  /** Returns the estimated amount of time left in the current idle period. */
  timeRemaining: () => number;
}

export interface IdleRequestOptionsLike {
  /** Maximum delay before the callback should be forced to run. */
  timeout?: number;
}

/** Callback signature used by the safe idle-callback wrapper. */
export type IdleRequestCallbackLike = (deadline: IdleDeadlineLike) => void;

/** Opaque handle returned by the native API or the timeout-based fallback. */
export type IdleCallbackHandle = number | ReturnType<typeof setTimeout>;

type IdleCallbackHost = Omit<
  typeof globalThis,
  "requestIdleCallback" | "cancelIdleCallback"
> & {
  requestIdleCallback?: (
    callback: IdleRequestCallbackLike,
    options?: IdleRequestOptionsLike,
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

const FALLBACK_IDLE_DELAY_MS = 1;
const IDLE_DEADLINE_BUDGET_MS = 50;

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Installs a `requestIdleCallback`/`cancelIdleCallback` shim on `globalThis`
 * when the runtime does not provide those browser APIs natively.
 *
 * This must run before third-party modules that dereference the globals
 * directly instead of going through the safe wrapper helpers below.
 */
function installIdleCallbackShim(): void {
  const host = globalThis as IdleCallbackHost;

  if (typeof host.requestIdleCallback !== "function") {
    host.requestIdleCallback = (callback) =>
      globalThis.setTimeout(() => {
        const startTime = now();
        callback(createFallbackIdleDeadline(startTime));
      }, FALLBACK_IDLE_DELAY_MS);
  }

  if (typeof host.cancelIdleCallback !== "function") {
    host.cancelIdleCallback = (handle) => {
      globalThis.clearTimeout(handle);
    };
  }
}

function createFallbackIdleDeadline(startTime: number): IdleDeadlineLike {
  return {
    didTimeout: false,
    timeRemaining: () =>
      Math.max(0, IDLE_DEADLINE_BUDGET_MS - (now() - startTime)),
  };
}

/**
 * Schedules low-priority work with the browser's idle callback API when
 * available, or with a minimal timeout-based shim otherwise.
 */
export function requestIdleCallbackSafe(
  callback: IdleRequestCallbackLike,
  options?: IdleRequestOptionsLike,
): IdleCallbackHandle {
  const host = globalThis as IdleCallbackHost;

  if (typeof host.requestIdleCallback === "function") {
    return host.requestIdleCallback(callback, options);
  }

  return globalThis.setTimeout(() => {
    const startTime = now();
    callback(createFallbackIdleDeadline(startTime));
  }, FALLBACK_IDLE_DELAY_MS);
}

/** Cancels work scheduled by {@link requestIdleCallbackSafe}. */
export function cancelIdleCallbackSafe(handle: IdleCallbackHandle): void {
  const host = globalThis as IdleCallbackHost;

  if (typeof host.cancelIdleCallback === "function") {
    host.cancelIdleCallback(handle);
    return;
  }

  globalThis.clearTimeout(handle);
}

installIdleCallbackShim();
