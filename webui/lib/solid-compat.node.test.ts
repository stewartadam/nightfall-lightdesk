// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";
import { createEffect } from "./solid-compat";

/** Verifies the effect runs once on creation, then once per changed compute value, with the previous value. */
test("createEffect runs the effect with each new value and the previous one", () => {
  const [count, setCount] = createSignal(1);
  const calls: [number, number | undefined][] = [];

  const dispose = createRoot((dispose) => {
    createEffect(count, (value, prev) => {
      calls.push([value, prev]);
    });
    return dispose;
  });

  setCount(2);
  setCount(3);
  assert.deepEqual(calls, [
    [1, undefined],
    [2, 1],
    [3, 2],
  ]);
  dispose();
});

/** Verifies a compute rerun that returns the same value (by ===) skips the effect. */
test("createEffect skips the effect when compute returns an identical value", () => {
  const [count, setCount] = createSignal(1);
  let runs = 0;

  const dispose = createRoot((dispose) => {
    createEffect(
      () => count() > 0,
      () => {
        runs += 1;
      },
    );
    return dispose;
  });

  setCount(2);
  setCount(5);
  assert.equal(
    runs,
    1,
    "positive stays positive, so the effect does not rerun",
  );
  setCount(-1);
  assert.equal(runs, 2);
  dispose();
});

/** Verifies `defer` skips the initial run but still records the first value as `prev`. */
test("createEffect with defer first runs on a change", () => {
  const [count, setCount] = createSignal(1);
  const calls: [number, number | undefined][] = [];

  const dispose = createRoot((dispose) => {
    createEffect(
      count,
      (value, prev) => {
        calls.push([value, prev]);
      },
      { defer: true },
    );
    return dispose;
  });

  assert.deepEqual(calls, []);
  setCount(2);
  assert.deepEqual(calls, [[2, 1]]);
  dispose();
});

/**
 * Verifies the returned cleanup runs before the next effect run and on disposal,
 * and survives a compute rerun that returns the same value.
 */
test("createEffect runs the returned cleanup before the next run and on dispose", () => {
  const [count, setCount] = createSignal(1);
  const log: string[] = [];

  const dispose = createRoot((dispose) => {
    createEffect(
      () => Math.min(count(), 2),
      (value) => {
        log.push(`run ${value}`);
        return () => log.push(`cleanup ${value}`);
      },
    );
    return dispose;
  });

  setCount(2);
  setCount(3);
  assert.deepEqual(log, ["run 1", "cleanup 1", "run 2"]);
  dispose();
  assert.deepEqual(log, ["run 1", "cleanup 1", "run 2", "cleanup 2"]);
});

/** Verifies signals read inside the effect half do not become dependencies. */
test("createEffect runs the effect untracked", () => {
  const [tracked, setTracked] = createSignal(0);
  const [untracked, setUntracked] = createSignal(0);
  let runs = 0;

  const dispose = createRoot((dispose) => {
    createEffect(tracked, () => {
      untracked();
      runs += 1;
    });
    return dispose;
  });

  setUntracked(1);
  assert.equal(runs, 1);
  setTracked(1);
  assert.equal(runs, 2);
  dispose();
});
