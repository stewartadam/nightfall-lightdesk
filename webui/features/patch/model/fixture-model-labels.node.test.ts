// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fixtureModelLabels } from "./fixture-model-labels";

/** Builds the fields of a patched fixture the label reads. */
function fixture(model: string, etag?: string, make = "Acme") {
  return { make, model, library_asset_etag: etag };
}

/** Leaves models alone while each make and model uses a single revision. */
test("fixtureModelLabels shows the model alone when one revision is patched", () => {
  assert.deepEqual(
    fixtureModelLabels(
      [
        fixture("Wash", "aaaaaaaaaa"),
        fixture("Wash", "aaaaaaaaaa"),
        fixture("Spot", "bbbbbbbbbb"),
        fixture("Wash", undefined),
      ],
      [],
    ),
    ["Wash", "Wash", "Spot", "Wash"],
  );
});

/**
 * Appends each revision once a make and model mixes them, naming it as the library does
 * and falling back to the fingerprint for revisions the library no longer lists.
 */
test("fixtureModelLabels appends the revision when a model mixes revisions", () => {
  assert.deepEqual(
    fixtureModelLabels(
      [
        fixture("Wash", "1111111111"),
        fixture("Wash", "2222222222"),
        fixture("Wash", "3333333333"),
        fixture("Wash", "1111111111", "Other"),
        fixture("Wash", undefined),
      ],
      [
        { asset_etag: "1111111111", gdtf_revision: "Release 1" },
        { asset_etag: "2222222222", gdtf_revision: "" },
      ],
    ),
    ["Wash (Release 1)", "Wash (22222222)", "Wash (33333333)", "Wash", "Wash"],
  );
});

/** Falls back to fingerprints for the whole model when two revisions share a name. */
test("fixtureModelLabels uses fingerprints when revision names collide", () => {
  assert.deepEqual(
    fixtureModelLabels(
      [fixture("Wash", "1111111111"), fixture("Wash", "2222222222")],
      [
        { asset_etag: "1111111111", gdtf_revision: "Initial" },
        { asset_etag: "2222222222", gdtf_revision: "Initial" },
      ],
    ),
    ["Wash (11111111)", "Wash (22222222)"],
  );
});

/** Uses whole fingerprints when even their starts match, as for retired built-ins. */
test("fixtureModelLabels uses whole fingerprints when their starts match", () => {
  assert.deepEqual(
    fixtureModelLabels(
      [fixture("Spot", "builtin:spot:v1"), fixture("Spot", "builtin:spot:v2")],
      [],
    ),
    ["Spot (builtin:spot:v1)", "Spot (builtin:spot:v2)"],
  );
});
