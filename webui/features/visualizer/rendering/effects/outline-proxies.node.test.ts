// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Group, Object3D } from "three";
import { syncOutlineProxyVisibility } from "./outline-proxies";

/** Builds a fixture group holding one hidden outline-only cell proxy, as LED bars and emitter batches do. */
function fixtureWithProxy(): { fixture: Group; proxy: Object3D } {
  const fixture = new Group();
  const proxy = new Object3D();
  proxy.userData.visualizerOutlineOnly = true;
  proxy.visible = false;
  fixture.add(proxy);
  return { fixture, proxy };
}

/**
 * The selection manager edits its outline arrays in place, so a selection made after the
 * outline passes were configured must still reveal its proxies on the next sync, and a
 * deselected fixture's proxies must hide again.
 */
test("outline proxies follow in-place selection edits", () => {
  const a = fixtureWithProxy();
  const b = fixtureWithProxy();
  const selected: Object3D[] = [];
  const selections = [selected, []];
  const visible = new Set<Object3D>();

  syncOutlineProxyVisibility(selections, visible);
  assert.equal(a.proxy.visible, false);

  selected.push(a.fixture);
  syncOutlineProxyVisibility(selections, visible);
  assert.equal(a.proxy.visible, true);
  assert.equal(b.proxy.visible, false);

  selected.length = 0;
  selected.push(b.fixture);
  syncOutlineProxyVisibility(selections, visible);
  assert.equal(a.proxy.visible, false);
  assert.equal(b.proxy.visible, true);
  assert.deepEqual([...visible], [b.proxy]);
});

/** A fixture rebuilt while selected swaps in new proxies; the old ones must not stay tracked. */
test("outline proxies follow a fixture rebuilt while selected", () => {
  const original = fixtureWithProxy();
  const selected: Object3D[] = [original.fixture];
  const visible = new Set<Object3D>();
  syncOutlineProxyVisibility([selected], visible);

  const rebuilt = fixtureWithProxy();
  selected[0] = rebuilt.fixture;
  syncOutlineProxyVisibility([selected], visible);
  assert.equal(original.proxy.visible, false);
  assert.equal(rebuilt.proxy.visible, true);
});

/** Ordinary (non-proxy) geometry keeps whatever visibility the scene gave it. */
test("outline proxy sync leaves ordinary meshes alone", () => {
  const fixture = new Group();
  const body = new Object3D();
  body.visible = false;
  fixture.add(body);
  syncOutlineProxyVisibility([[fixture]], new Set());
  assert.equal(body.visible, false);
});
