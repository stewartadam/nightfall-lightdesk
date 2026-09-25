// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import {
  type BeamLightSample,
  buildBeamLightProxies,
  MAX_PROXIES_PER_FIXTURE,
} from "./beam-light-proxies";

const DOWN = new Vector3(0, -1, 0);

/** Builds a downward beam sample at `x` meters along a fixture. */
function pixel(
  x: number,
  color: [number, number, number],
  overrides: Partial<BeamLightSample> = {},
): BeamLightSample {
  return {
    beamId: `bar:${x}:${overrides.fixtureUid ?? ""}`,
    fixtureUid: "bar",
    position: new Vector3(x, 4, 0),
    direction: DOWN.clone(),
    halfAngle: 0.1,
    intensity: 10,
    red: color[0],
    green: color[1],
    blue: color[2],
    ...overrides,
  };
}

/** Asserts a value lies within a tolerance of the expected value. */
function near(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message}: ${actual} vs ${expected}`,
  );
}

/** Verifies a compact pixel head becomes one proxy carrying the summed output and blended color. */
test("interleaved red and blue pixels blend into one proxy", () => {
  const samples = Array.from({ length: 20 }, (_, index) =>
    pixel(index * 0.01, index % 2 === 0 ? [1, 0, 0] : [0, 0, 1]),
  );
  const proxies = buildBeamLightProxies(samples);
  assert.equal(proxies.length, 1);
  near(proxies[0].intensity, 200, "summed intensity");
  near(proxies[0].red, 0.5, "red share");
  near(proxies[0].blue, 0.5, "blue share");
  assert.equal(proxies[0].beamCount, 20);
});

/** Verifies a long bar lit red on one half and blue on the other keeps both colors as segments. */
test("a bar split by color keeps separate segments", () => {
  const samples = Array.from({ length: 100 }, (_, index) =>
    pixel(index * 0.01, index < 50 ? [1, 0, 0] : [0, 0, 1]),
  );
  const proxies = buildBeamLightProxies(samples).sort(
    (a, b) => a.position.x - b.position.x,
  );
  assert.equal(proxies.length, 3);
  near(proxies[0].red, 1, "left segment is red");
  near(proxies[proxies.length - 1].blue, 1, "right segment is blue");
});

/** Verifies long fixtures are capped at the per-fixture proxy limit and fixtures stay separate. */
test("proxies are capped per fixture and grouped by fixture", () => {
  const long = Array.from({ length: 50 }, (_, index) =>
    pixel(index * 0.1, [1, 1, 1]),
  );
  const other = [pixel(0, [1, 1, 1], { fixtureUid: "spot" })];
  const proxies = buildBeamLightProxies([...long, ...other]);
  assert.equal(
    proxies.filter((proxy) => proxy.fixtureUid === "bar").length,
    MAX_PROXIES_PER_FIXTURE,
  );
  assert.equal(
    proxies.filter((proxy) => proxy.fixtureUid === "spot").length,
    1,
  );
});

/** Verifies a gobo beam keeps its own proxy and image even beside other lit beams of its fixture. */
test("gobo beams keep their own proxy next to open beams", () => {
  const gobo = { name: "stars" };
  const proxies = buildBeamLightProxies([
    pixel(0, [1, 1, 1], { gobo }),
    pixel(0.01, [1, 0, 0]),
    pixel(0.02, [1, 0, 0]),
  ]);
  assert.equal(proxies.length, 2);
  const goboProxy = proxies.find((proxy) => proxy.gobo === gobo);
  assert.ok(goboProxy, "gobo beam projects its image");
  assert.equal(goboProxy.beamCount, 1);
  near(goboProxy.halfAngle, 0.1, "gobo cone unchanged");
  assert.equal(proxies.find((proxy) => proxy !== goboProxy)?.beamCount, 2);
});

/** Verifies merged open beams get a cone wide enough to cover each member. */
test("merged cones cover their members", () => {
  const tilted = new Vector3(0.2, -1, 0).normalize();
  const [merged] = buildBeamLightProxies([
    pixel(0, [1, 1, 1]),
    pixel(0.01, [1, 1, 1], { direction: tilted }),
  ]);
  assert.ok(
    merged.halfAngle > 0.1,
    `merged cone ${merged.halfAngle} covers both beams`,
  );
});

/** Verifies emitters facing opposite ways get separate proxies pointing their own way. */
test("opposed emitters are not averaged into one direction", () => {
  const up = new Vector3(0, 1, 0);
  const proxies = buildBeamLightProxies([
    pixel(0, [1, 1, 1]),
    pixel(0.01, [1, 1, 1], { direction: up }),
  ]);
  assert.equal(proxies.length, 2);
  const directions = proxies.map((proxy) => Math.round(proxy.direction.y));
  assert.deepEqual(directions.sort(), [-1, 1]);
});

/** Verifies proxy keys stay the same across frames for the same beams. */
test("proxy keys are stable across frames", () => {
  const frame = () =>
    buildBeamLightProxies(
      Array.from({ length: 30 }, (_, index) => pixel(index * 0.05, [1, 1, 1])),
    )
      .map((proxy) => proxy.key)
      .sort();
  assert.deepEqual(frame(), frame());
});

/** Verifies dark beams contribute nothing. */
test("unlit beams produce no proxies", () => {
  assert.deepEqual(
    buildBeamLightProxies([pixel(0, [1, 0, 0], { intensity: 0 })]),
    [],
  );
});
