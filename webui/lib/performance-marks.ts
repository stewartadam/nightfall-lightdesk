// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Starts a User Timing measurement and returns a finisher for the measured scope.
 */
export function startPerformanceMeasure(
  name: string,
): (detail?: unknown) => void {
  const startMark = `nightfall:${name}:start:${performance.now()}:${Math.random()}`;
  performance.mark(startMark);

  return (detail?: unknown) => {
    const measureName = `nightfall:${name}`;
    try {
      performance.measure(measureName, { start: startMark, detail });
    } catch {
      performance.measure(measureName, startMark);
    } finally {
      performance.clearMarks(startMark);
    }
  };
}

/**
 * Measures a synchronous block with the browser User Timing API.
 */
export function measurePerformanceScope<T>(
  name: string,
  callback: () => T,
  detail?: unknown,
): T {
  const finish = startPerformanceMeasure(name);
  try {
    return callback();
  } finally {
    finish(detail);
  }
}

/**
 * Measures elapsed time from now until the next animation frame callback.
 */
export function measureNextAnimationFrame(
  name: string,
  detail?: unknown,
): void {
  const finish = startPerformanceMeasure(name);
  requestAnimationFrame(() => finish(detail));
}
