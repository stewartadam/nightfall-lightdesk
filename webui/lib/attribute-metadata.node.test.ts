// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AttributeCategory } from "../types";
import {
  getAttributeMetadata,
  setAttributeMetadata,
} from "./attribute-metadata";

/**
 * Verifies exact metadata keys are preserved when a later normalized alias points to them.
 */
test("exact attribute metadata takes precedence over normalized aliases", () => {
  setAttributeMetadata([
    {
      key: "Intensity",
      attribute: { type: "Intensity" },
      label: "Intensity",
      category: AttributeCategory.Dimmer,
      sort_order: 0,
    },
    {
      key: "VirtualIntensity",
      attribute: { type: "VirtualIntensity" },
      label: "Virtual Intensity",
      category: AttributeCategory.Dimmer,
      sort_order: 1,
    },
  ]);

  assert.equal(getAttributeMetadata("Intensity")?.attribute.type, "Intensity");
  assert.equal(
    getAttributeMetadata("VirtualIntensity")?.attribute.type,
    "VirtualIntensity",
  );
});

/**
 * Verifies normalized lookups still work when no exact metadata entry exists.
 */
test("normalized aliases resolve when no exact attribute metadata exists", () => {
  setAttributeMetadata([
    {
      key: "VirtualIntensity",
      attribute: { type: "VirtualIntensity" },
      label: "Virtual Intensity",
      category: AttributeCategory.Dimmer,
      sort_order: 1,
    },
  ]);

  assert.equal(
    getAttributeMetadata("Intensity")?.attribute.type,
    "VirtualIntensity",
  );
});
