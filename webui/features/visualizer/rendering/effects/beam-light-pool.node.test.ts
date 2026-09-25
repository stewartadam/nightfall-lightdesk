// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Scene, Texture, Vector3 } from "three/webgpu";
import {
  BeamLightPool,
  GOBO_RESERVED_SHARE,
  selectProxies,
} from "./beam-light-pool";
import type { BeamLightProxy } from "./beam-light-proxies";

// Node has no ImageData; lights returning to white build one.
(globalThis as any).ImageData ??= class {
  /** Mirrors the browser constructor's pixel data and dimensions. */
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
};

/** Builds a gobo texture whose image has the given size. */
function gobo(size: number): Texture {
  return new Texture({ width: size, height: size } as never);
}

/** Builds a downward proxy with the given key, intensity and optional gobo. */
function proxy(
  key: string,
  intensity: number,
  image?: Texture,
): BeamLightProxy {
  return {
    key,
    fixtureUid: key.split(":")[0],
    position: new Vector3(0, 4, 0),
    direction: new Vector3(0, -1, 0),
    halfAngle: 0.2,
    intensity,
    red: 1,
    green: 1,
    blue: 1,
    gobo: image,
    beamCount: 1,
  };
}

/** Returns the pool light standing for a fixture, if any. */
function lightFor(pool: BeamLightPool, fixtureUid: string) {
  return pool.lights.find((light) => light.userData.fixtureUid === fixtureUid);
}

/** Verifies proxies keep their lights when their brightness order flips. */
test("proxies keep their lights when brightness order changes", () => {
  const pool = new BeamLightPool(new Scene(), 4);
  const stars = gobo(256);
  const dots = gobo(512);
  pool.assign([proxy("a:gobo:1", 10, stars), proxy("b:gobo:1", 5, dots)]);
  const lightA = lightFor(pool, "a");
  const lightB = lightFor(pool, "b");
  const mapA = lightA?.map;
  const mapB = lightB?.map;

  pool.assign([proxy("a:gobo:1", 5, stars), proxy("b:gobo:1", 10, dots)]);
  assert.equal(lightFor(pool, "a"), lightA);
  assert.equal(lightFor(pool, "b"), lightB);
  assert.equal(lightA?.map, mapA, "no new map for a");
  assert.equal(lightB?.map, mapB, "no new map for b");
});

/** Verifies open proxies avoid lights holding a map, and gobo proxies reuse one. */
test("gobo proxies reuse mapped lights and open proxies avoid them", () => {
  const pool = new BeamLightPool(new Scene(), 3);
  const stars = gobo(256);
  pool.assign([proxy("a:gobo:1", 10, stars)]);
  const mapped = lightFor(pool, "a");
  const map = mapped?.map;

  // The gobo spot goes dark while an open wash lights up: the wash must not
  // take the mapped light.
  pool.assign([proxy("wash:0:0", 20)]);
  assert.notEqual(lightFor(pool, "wash"), mapped);

  // A new gobo beam of the same size takes the mapped light without a new map.
  pool.assign([proxy("wash:0:0", 20), proxy("c:gobo:1", 5, gobo(256))]);
  assert.equal(lightFor(pool, "c"), mapped);
  assert.equal(mapped?.map, map);
  assert.equal(
    pool.lights.filter((light) => light.map).length,
    1,
    "only one light holds a map",
  );
});

/** Verifies a dim gobo proxy still gets a light when brighter merged open proxies fill the pool. */
test("gobo proxies keep a light when open proxies outnumber the pool", () => {
  const pool = new BeamLightPool(new Scene(), 4);
  const open = Array.from({ length: 8 }, (_, index) =>
    proxy(`bar${index}:0:0`, 100 + index),
  );
  pool.assign([...open, proxy("spot:gobo:1", 10, gobo(256))]);
  const goboLight = lightFor(pool, "spot");
  assert.ok(goboLight, "gobo proxy is lit");
  assert.equal(goboLight.userData.projectsGobo, true);
  assert.equal(
    pool.lights.filter((light) => light.intensity > 0).length,
    4,
    "every light is used",
  );
  assert.ok(lightFor(pool, "bar7"), "brightest open proxy is lit");
});

/** Verifies gobo proxies take at most their reserved share, leaving the rest to the brightest proxies. */
test("gobo reservation leaves lights for bright open proxies", () => {
  const gobos = Array.from({ length: 6 }, (_, index) =>
    proxy(`spot${index}:gobo:1`, 1, gobo(256)),
  );
  const open = [proxy("wash:0:0", 100), proxy("bar:0:0", 50)];
  const selected = selectProxies([...gobos, ...open], 4);
  assert.equal(selected.length, 4);
  assert.equal(
    selected.filter((entry) => entry.gobo instanceof Texture).length,
    Math.ceil(4 * GOBO_RESERVED_SHARE),
  );
  assert.ok(selected.some((entry) => entry.key === "wash:0:0"));
  assert.ok(selected.some((entry) => entry.key === "bar:0:0"));
});
