// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as types from "../types/index";
import { validateCommandSemantics } from "./command-semantic-validation";
import {
  defaultNetworkDmxOutputs,
  defaultUsbDmxOutputs,
  refreshReservedOutputTargetKeywords,
} from "./network-dmx-output-targets";

before(async () => {
  await refreshReservedOutputTargetKeywords();
});

/**
 * Builds minimal IO runtime settings for command semantic validation tests.
 */
function makeSettings(
  targets: types.NetworkDmxOutputTarget[],
  usbTargets: types.UsbDmxOutputTarget[] = defaultUsbDmxOutputs().targets,
): types.IoRuntimeSettings {
  return {
    input_signal_loss_policy: { type: "Hold" },
    input_signal_loss_timeout: { secs: 2, nanos: 0 },
    input_universe_visibility_mode:
      types.InputUniverseVisibilityMode.ExternalOnly,
    network_output_enabled: true,
    network_input_enabled: true,
    usb_output_enabled: true,
    network_dmx_outputs: { targets },
    usb_dmx_outputs: { targets: usbTargets },
  };
}

const configuredTargets: types.NetworkDmxOutputTarget[] = [
  ...defaultNetworkDmxOutputs().targets,
  {
    id: "sacnnode4",
    protocol: types.NetworkDmxProtocol.Sacn,
    delivery: { type: "Unicast", data: { ip: "192.168.1.44" } },
  },
];

test("validateCommandSemantics accepts configured output transport patch targets", async () => {
  assert.deepEqual(
    await validateCommandSemantics(
      "patch fix 4 @sacnnode4:0.50",
      makeSettings(configuredTargets),
    ),
    { status: "ok" },
  );
});

test("validateCommandSemantics rejects unknown output transport patch targets", async () => {
  const result = await validateCommandSemantics(
    "patch fix 4 @missingnode:0.50",
    makeSettings(configuredTargets),
  );

  assert.equal(result.status, "error");
  assert.match(result.status === "error" ? result.message : "", /missingnode/);
});

test("validateCommandSemantics ignores source-side transport names", async () => {
  assert.deepEqual(
    await validateCommandSemantics(
      "patch missingnode:1.1 @ console:1.1",
      makeSettings(configuredTargets),
    ),
    { status: "ok" },
  );
});

test("validateCommandSemantics accepts built-in Art-Net target spelling", async () => {
  assert.deepEqual(
    await validateCommandSemantics(
      "patch fix 4 @artnet:0.1",
      makeSettings(configuredTargets),
    ),
    { status: "ok" },
  );
});

test("validateCommandSemantics accepts legacy uDMX patch targets", async () => {
  assert.deepEqual(
    await validateCommandSemantics(
      "patch fix 4 @udmx:1.1",
      makeSettings(configuredTargets),
    ),
    { status: "ok" },
  );
});

test("validateCommandSemantics accepts configured USB patch targets", async () => {
  assert.deepEqual(
    await validateCommandSemantics(
      "patch fix 4 @front-usb:1.1",
      makeSettings(configuredTargets, [
        ...defaultUsbDmxOutputs().targets,
        {
          id: "front-usb",
          device: "usb-serial-1",
          device_label: "Anyma uDMX",
        },
      ]),
    ),
    { status: "ok" },
  );
});

test("validateCommandSemantics checks every command in a command chain", async () => {
  const result = await validateCommandSemantics(
    "patch fix 1 @sacn:1.1; patch fix 2 @unknownnode:1.2",
    makeSettings(configuredTargets),
  );

  assert.equal(result.status, "error");
  assert.match(result.status === "error" ? result.message : "", /unknownnode/);
});
