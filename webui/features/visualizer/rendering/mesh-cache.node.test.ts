// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from "three/webgpu";
import { FixtureMeshCache } from "./mesh-cache";
import { disposeFixtureMesh } from "./mesh-ownership";

/** Create a template with an exactly measurable backing buffer and no external assets. */
function model(bytes = 36): Group {
  const geometry = new BufferGeometry();
  const array = new Float32Array(bytes / 4);
  geometry.setAttribute("position", new BufferAttribute(array, 3));
  geometry.setAttribute("normal", new BufferAttribute(array, 3));
  const root = new Group();
  root.add(new Mesh(geometry, new MeshStandardMaterial()));
  return root;
}

/** LRU eviction drops the template reference but must preserve a still-visible fixture's geometry. */
test("mesh cache evicts the least recently used template without disposing live geometry", async () => {
  const cache = new FixtureMeshCache(2, 1000);
  let aLoads = 0;
  let bLoads = 0;
  let bDisposals = 0;
  const aFactory = async () => {
    aLoads++;
    return model();
  };
  const bFactory = async () => {
    bLoads++;
    const template = model();
    (template.children[0] as Mesh).geometry.addEventListener("dispose", () => {
      bDisposals++;
    });
    return template;
  };
  const a = await cache.load("a", aFactory);
  const b = await cache.load("b", bFactory);
  const aAgain = await cache.load("a", aFactory);
  const c = await cache.load("c", async () => model());
  assert.deepEqual(cache.stats, { templates: 2, bytes: 72, pending: 0 });
  assert.equal(aLoads, 1);
  assert.equal(bDisposals, 0);
  disposeFixtureMesh(b);
  assert.equal(bDisposals, 1);
  const bAgain = await cache.load("b", bFactory);
  assert.equal(bLoads, 2);
  for (const copy of [a, aAgain, bAgain, c]) disposeFixtureMesh(copy);
});

/** Oversized templates can serve all current waiters but must not remain in cache afterward. */
test("mesh cache enforces byte budget after coalesced oversized loads", async () => {
  const cache = new FixtureMeshCache(10, 35);
  let loads = 0;
  let disposals = 0;
  const factory = async () => {
    loads++;
    const template = model();
    (template.children[0] as Mesh).geometry.addEventListener("dispose", () => {
      disposals++;
    });
    return template;
  };
  const [a, b] = await Promise.all([
    cache.load("large", factory),
    cache.load("large", factory),
  ]);
  assert.equal(loads, 1);
  assert.notEqual(a, b);
  assert.deepEqual(cache.stats, { templates: 0, bytes: 0, pending: 0 });
  assert.equal(disposals, 0);
  disposeFixtureMesh(a);
  assert.equal(disposals, 0);
  disposeFixtureMesh(b);
  assert.equal(disposals, 1);
  disposeFixtureMesh(await cache.load("large", factory));
  assert.equal(loads, 2);
  assert.equal(disposals, 2);
});

/** Concurrent failures must not multiply retries; a new request after failure can try again. */
test("mesh cache coalesces failed requests and recovers on a later call", async () => {
  const cache = new FixtureMeshCache();
  let attempts = 0;
  const factory = async () => {
    attempts++;
    throw new Error("unavailable revision");
  };
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => cache.load("missing", factory)),
  );
  assert.equal(attempts, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.deepEqual(cache.stats, { templates: 0, bytes: 0, pending: 0 });
  const recovered = await cache.load("missing", async () => {
    attempts++;
    return model();
  });
  assert.equal(attempts, 2);
  assert.equal(cache.stats.templates, 1);
  disposeFixtureMesh(recovered);
});

/** Pending work cannot be evicted before its waiters receive copies, even if other requests finish first. */
test("mesh cache preserves pending loads under eviction pressure", async () => {
  const cache = new FixtureMeshCache(1, 1000);
  let resolve!: (group: Group) => void;
  const pending = new Promise<Group>((done) => {
    resolve = done;
  });
  const slow = cache.load("slow", () => pending);
  const first = await cache.load("first", async () => model());
  const second = await cache.load("second", async () => model());
  assert.deepEqual(cache.stats, { templates: 1, bytes: 36, pending: 1 });
  resolve(model());
  const finished = await slow;
  assert.deepEqual(cache.stats, { templates: 1, bytes: 36, pending: 0 });
  for (const copy of [first, second, finished]) disposeFixtureMesh(copy);
});
