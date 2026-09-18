// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { type BackendSlot, expect, test } from "./playwright-fixtures";

type SlotRecord = {
  backendPort: number;
  dataDir: string;
  testId: string;
};

const REQUIRED_SLOT_COUNT = 6;

test.describe.configure({ mode: "parallel" });

/** Reads the latest record for every test participating in this pool check. */
function readSlotRecords(recordPath: string): SlotRecord[] {
  if (!existsSync(recordPath)) return [];
  const records = readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SlotRecord);
  return [
    ...new Map(records.map((record) => [record.testId, record])).values(),
  ];
}

/** Proves concurrent tests receive clean slots with physical transports off. */
async function verifyIsolatedBackendSlot(
  backendSlot: BackendSlot,
  testId: string,
) {
  const defaultShowfilePath = join(
    backendSlot.dataDir,
    "default.nightfall-show",
    "showfile.json",
  );
  await expect.poll(() => existsSync(defaultShowfilePath)).toBe(true);
  const settings = JSON.parse(
    readFileSync(defaultShowfilePath, "utf8"),
  ).settings;
  expect(settings.network_input_enabled).toBe(false);
  expect(settings.network_output_enabled).toBe(false);
  expect(settings.usb_output_enabled).toBe(false);

  const markerPath = join(backendSlot.dataDir, "pool-isolation-marker");
  expect(existsSync(markerPath)).toBe(false);
  writeFileSync(markerPath, testId, "utf8");

  const recordPath = join(backendSlot.runRoot, "backend-pool-isolation.jsonl");
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      backendPort: backendSlot.backendPort,
      dataDir: backendSlot.dataDir,
      testId,
    })}\n`,
    "utf8",
  );

  await expect
    .poll(() => readSlotRecords(recordPath).length, { timeout: 30_000 })
    .toBe(REQUIRED_SLOT_COUNT);
  const records = readSlotRecords(recordPath);
  expect(new Set(records.map((record) => record.backendPort)).size).toBe(
    REQUIRED_SLOT_COUNT,
  );
  expect(
    new Set(
      records.flatMap((record) => [record.backendPort, record.backendPort + 1]),
    ).size,
  ).toBe(REQUIRED_SLOT_COUNT * 2);
  expect(new Set(records.map((record) => record.dataDir)).size).toBe(
    REQUIRED_SLOT_COUNT,
  );
}

/** Registers one pool test that joins the six-slot isolation rendezvous. */
function registerBackendSlotTest(slotLabel: string) {
  test(`parallel backend slot ${slotLabel} is isolated`, async ({
    backendSlot,
  }, testInfo) => {
    test.skip(
      testInfo.config.workers < REQUIRED_SLOT_COUNT,
      "requires at least six workers",
    );
    await verifyIsolatedBackendSlot(backendSlot, testInfo.testId);
  });
}

/** Verifies slot A receives an independently seeded backend. */
registerBackendSlotTest("A");
/** Verifies slot B receives an independently seeded backend. */
registerBackendSlotTest("B");
/** Verifies slot C receives an independently seeded backend. */
registerBackendSlotTest("C");
/** Verifies slot D receives an independently seeded backend. */
registerBackendSlotTest("D");
/** Verifies slot E receives an independently seeded backend. */
registerBackendSlotTest("E");
/** Verifies slot F receives an independently seeded backend. */
registerBackendSlotTest("F");
