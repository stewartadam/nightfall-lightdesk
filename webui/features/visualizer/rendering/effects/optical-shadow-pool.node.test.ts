// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Scene, type WebGPURenderer } from "three/webgpu";
import {
  OpticalShadowPool,
  type OpticalShadowSource,
  type ShadowSlot,
} from "./optical-shadow-pool";
import { OpticalSurfaceLight } from "./optical-surface-lighting";
import { ShadowRefreshBudget } from "./shadow-refresh-budget";

const FRAME_MS = 16;
const INTERVAL_MS = 60;

/** Records which sources were rendered instead of issuing GPU work. */
class RecordingShadowPool extends OpticalShadowPool {
  readonly rendered: OpticalShadowSource[] = [];

  /** Captures the slot's source; scheduling and pose bookkeeping still run unchanged. */
  protected override renderMap(
    _renderer: WebGPURenderer,
    _scene: Scene,
    slot: ShadowSlot,
  ): void {
    this.rendered.push(slot.source!);
  }
}

/** Creates a bright source two meters up, projecting along -Z like an unposed light. */
function createSource(x: number): OpticalSurfaceLight {
  const light = new OpticalSurfaceLight({
    shape: "round",
    radius: 0.05,
    slopeX: 0.2,
    slopeY: 0.2,
    halfPowerRatio: 0.5,
    distributionPower: 2,
    lumens: 1000,
  });
  light.position.set(x, 2, 0);
  light.intensity = 1;
  light.beamLength = 8;
  return light;
}

/** Builds a pool with registered sources and a camera looking at them. */
function setup(count: number) {
  const pool = new RecordingShadowPool();
  const sources = Array.from({ length: count }, (_, i) => createSource(i));
  for (const source of sources) pool.register(source);
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1, 6);
  camera.updateMatrixWorld();
  const renderer = {} as WebGPURenderer;
  const scene = new Scene();
  /** Advances the pool one frame with an optional refresh grant. */
  const frame = (now: number, allow: boolean, interval = INTERVAL_MS) =>
    pool.update(renderer, scene, camera, now, allow, interval);
  return { pool, sources, frame };
}

/** Maps refreshed at the budget's cadence never lapse between refreshes. */
test("maps refreshed at the granted cadence stay valid continuously", () => {
  const { pool, sources, frame } = setup(2);
  let lastGrant = -Infinity;
  for (let now = 0; now < 5000; now += FRAME_MS) {
    const allow = now - lastGrant >= INTERVAL_MS;
    if (allow) lastGrant = now;
    frame(now, allow);
    if (now >= INTERVAL_MS * 2)
      for (const source of sources)
        assert.ok(pool.hasValidMap(source), `map lapsed at ${now}ms`);
  }
});

/** Maps survive several missed refresh cycles but expire once staleness exceeds the cadence-derived bound. */
test("maps expire only after several missed refresh cycles", () => {
  const { pool, sources, frame } = setup(1);
  frame(0, true);
  assert.ok(pool.hasValidMap(sources[0]));
  frame(INTERVAL_MS * 6, false);
  assert.ok(pool.hasValidMap(sources[0]), "one missed cycle must not expire");
  frame(INTERVAL_MS * 2 * 5 + 1, false);
  assert.equal(pool.hasValidMap(sources[0]), false);
  frame(INTERVAL_MS * 2 * 5 + 2, true);
  assert.ok(pool.hasValidMap(sources[0]), "a refresh restores the map");
  // A slower cadence stretches the lifetime proportionally.
  frame(INTERVAL_MS * 2 * 5 + 2 + 200 * 2 * 4, false, 200);
  assert.ok(pool.hasValidMap(sources[0]));
});

/** A moving head keeps its slightly stale map and is refreshed before unchanged sources. */
test("moving sources keep their map and are refreshed first", () => {
  const { pool, frame } = setup(2);
  frame(0, true);
  frame(INTERVAL_MS, true);
  const [, newest] = pool.rendered;
  newest.position.x += 0.5;
  newest.optics.slopeX = 0.3;
  frame(INTERVAL_MS + 20, false);
  assert.ok(pool.hasValidMap(newest), "movement must not drop the map");
  frame(INTERVAL_MS * 2, true);
  assert.equal(pool.rendered.at(-1), newest);
  frame(INTERVAL_MS * 3, true);
  assert.notEqual(pool.rendered.at(-1), newest, "unchanged sources still age");
});

/** Shadow keys stay small, unique and non-zero regardless of scene object IDs. */
test("shadow keys are small pool-owned indices that are recycled", () => {
  const { pool, sources } = setup(3);
  assert.deepEqual(
    sources.map((source) => source.shadowKey),
    [1, 2, 3],
  );
  pool.unregister(sources[1]);
  assert.equal(sources[1].shadowKey, 0);
  const replacement = createSource(5);
  pool.register(replacement);
  assert.equal(replacement.shadowKey, 2);
  pool.register(replacement);
  assert.equal(replacement.shadowKey, 2, "re-registration keeps the key");
});

/** Removing a source immediately stops shaders from sampling its map. */
test("unregistering invalidates the source's map", () => {
  const { pool, sources, frame } = setup(1);
  frame(0, true);
  assert.ok(pool.hasValidMap(sources[0]));
  pool.unregister(sources[0]);
  assert.equal(pool.hasValidMap(sources[0]), false);
  assert.equal(frame(1, true), 0);
});

/** Without any GPU timing, the budget and pool together keep shadow maps valid over time, even while a source moves. */
test("shadows remain visible over time without GPU timing", () => {
  const { pool, sources, frame } = setup(2);
  const budget = new ShadowRefreshBudget();
  let firstValid = Infinity;
  for (let now = 0; now < 10000; now += FRAME_MS) {
    sources[0].position.x = Math.sin(now / 1000);
    const allow = budget.canRefresh(undefined, 1, now);
    frame(now, allow, budget.refreshIntervalMs);
    budget.recordRender(3, 1);
    const valid = sources.every((source) => pool.hasValidMap(source));
    if (valid) firstValid = Math.min(firstValid, now);
    else assert.equal(firstValid, Infinity, `map lapsed at ${now}ms`);
  }
  assert.ok(firstValid < 1000, "maps must appear promptly");
});
