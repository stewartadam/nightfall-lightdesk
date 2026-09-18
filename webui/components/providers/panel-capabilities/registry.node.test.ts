// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";
import {
  PANEL_FOCUS_CAPABILITY,
  RENDER_PROPERTIES_CAPABILITY,
  REVEAL_OBJECT_CAPABILITY,
  type RenderPropertiesMetadata,
} from "../../../lib/panel-capabilities";
import {
  createPanelCapabilityRegistry,
  panelCapabilityDeclarationStatus,
} from "../../../lib/panel-capability-registry";

/** Verifies queued requests are delivered once a matching handler registers. */
test("panel capability registry drains queued invocations on registration", () => {
  createRoot((dispose) => {
    const registry = createPanelCapabilityRegistry();
    const deliveredRequests: Array<{
      requestId: number;
      type: string;
      uid: string;
    }> = [];

    const requestId = registry.invokePanelCapability(
      "panel-FixtureGrid",
      REVEAL_OBJECT_CAPABILITY,
      { type: "fixture", uid: "fixture-1" },
    );

    assert.equal(deliveredRequests.length, 0);

    registry.registerPanelCapability(
      "panel-FixtureGrid",
      REVEAL_OBJECT_CAPABILITY,
      (request) => {
        deliveredRequests.push(request);
      },
      {
        accepts: (payload) => payload.type === "fixture",
      },
    );

    assert.deepEqual(deliveredRequests, [
      { requestId, type: "fixture", uid: "fixture-1" },
    ]);

    dispose();
  });
});

/** Verifies capability declaration validation follows static PanelDefinition data. */
test("panel capability registry validates against panel definitions", () => {
  assert.equal(
    panelCapabilityDeclarationStatus(
      "panel-FixtureGrid",
      REVEAL_OBJECT_CAPABILITY,
    ),
    "declared",
  );
  assert.equal(
    panelCapabilityDeclarationStatus(
      "panel-Visualizer",
      REVEAL_OBJECT_CAPABILITY,
    ),
    "undeclared-capability",
  );
  assert.equal(
    panelCapabilityDeclarationStatus("dynamic-panel", PANEL_FOCUS_CAPABILITY),
    "unknown-panel",
  );
});

/** Verifies render-properties registrations expose typed inspector metadata. */
test("panel capability registry exposes properties provider metadata", () => {
  createRoot((dispose) => {
    const registry = createPanelCapabilityRegistry();
    const component = () => "Properties";
    const metadata: RenderPropertiesMetadata = {
      label: "Fixture",
      priority: 10,
      component,
    };
    const unregister = registry.registerPanelCapability(
      "panel-FixtureGrid",
      RENDER_PROPERTIES_CAPABILITY,
      () => {},
      { metadata },
    );

    const registrations = registry.getPanelCapabilityRegistrations(
      RENDER_PROPERTIES_CAPABILITY,
    );
    const registration = registrations.get("panel-FixtureGrid");

    assert.equal(registrations.size, 1);
    assert.deepEqual(registration, {
      panelId: "panel-FixtureGrid",
      metadata,
    });
    assert.equal(registration?.metadata?.component(), "Properties");

    unregister();

    assert.equal(
      registry.getPanelCapabilityRegistrations(RENDER_PROPERTIES_CAPABILITY)
        .size,
      0,
    );

    dispose();
  });
});
