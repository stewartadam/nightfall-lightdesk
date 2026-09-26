// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compilePrismFacet, PrismStack } from "./prism-optics";

/** Budget reduction samples the full combination range and still applies later optical stages. */
test("oversized prism stacks retain bounded contributions from every stage", () => {
  const facets = Array.from({ length: 4 }, (_, x) => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x,
    y: 0,
    determinant: 1,
    red: 1,
    green: 1,
    blue: 1,
  }));
  const stages = [
    { facets, rotation: 0 },
    {
      facets: facets.map((facet) => ({ ...facet, x: 0, y: facet.x })),
      rotation: Math.PI / 2,
    },
  ];
  const stack = new PrismStack(3, [3], true);
  const result = stack.compose(stages)!;
  assert.equal(result.length, 3);
  assert.ok(
    result.every(
      (facet) => Number.isFinite(facet.x) && Number.isFinite(facet.y),
    ),
  );
  assert.ok(result.some((facet) => Math.abs(facet.x) > 0.5));
  assert.ok(result.some((facet) => Math.abs(facet.y) > 0.5));
  assert.equal(stack.compose(stages), result);
  stages[1].rotation = 0;
  const straight = stack.compose(stages)!;
  assert.ok(straight.every((facet) => facet.x >= 0 && facet.y >= 0));
  assert.ok(straight.some((facet) => facet.x >= 2 && facet.y >= 2));
});

/** Stacked prisms multiply beam count, apply transforms in optical order, and multiply transmission. */
test("prism stack composes affine stages into reusable facet records", () => {
  const first = [-1, 1].map((x) => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x,
    y: 0,
    determinant: 1,
    red: 0.5,
    green: 1,
    blue: 1,
  }));
  const second = [-2, 0, 2].map((y) => ({
    a: 2,
    b: 0,
    c: 0,
    d: 1,
    x: 0,
    y,
    determinant: 2,
    red: 1,
    green: 0.25,
    blue: 1,
  }));
  const stack = new PrismStack(6, [2, 3, 6]);
  const stages = [
    { facets: first, rotation: 0 },
    { facets: second, rotation: Math.PI / 2 },
  ];
  const output = stack.compose(stages)!;
  assert.equal(output.length, 6);
  assert.ok(Math.abs(output[0].x - 2) < 1e-12);
  assert.ok(Math.abs(output[0].y + 2) < 1e-12);
  assert.ok(Math.abs(output[5].x + 2) < 1e-12);
  assert.ok(Math.abs(output[5].y - 2) < 1e-12);
  assert.equal(output[0].determinant, 2);
  assert.equal(output[0].red, 0.5);
  assert.equal(output[0].green, 0.25);
  const facet = output[0];
  stages[1].rotation = 0;
  assert.equal(stack.compose(stages), output);
  assert.equal(output[0], facet);
  assert.equal(output[0].x, -2);
  assert.equal(output[0].y, -2);
  const single = stack.compose([stages[0]])!;
  assert.equal(single.length, 2);
  assert.equal(output.length, 6);
  assert.equal(stack.compose([stages[0]]), single);
  assert.equal(stack.compose([]), undefined);
  assert.equal(stack.compose(stages), output);
  assert.throws(() => stack.compose([...stages, stages[0]]), /capacity/);
  assert.equal(output[0].x, -2);
});

/** Invalid projective or collapsed matrices never enter the atmospheric draw. */
test("prism compilation rejects singular and non-affine transforms", () => {
  assert.equal(
    compilePrismFacet({
      transform: [0, 0, 0, 0, 0, 0, 0, 0, 1],
      colorCie: [0.3127, 0.329, 100],
    }),
    undefined,
  );
  assert.equal(
    compilePrismFacet({
      transform: [1, 0, 1, 0, 1, 0, 0, 0, 1],
      colorCie: [0.3127, 0.329, 100],
    }),
    undefined,
  );
});
