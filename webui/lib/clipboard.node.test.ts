// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ClipboardUnavailableError,
  readClipboardText,
  writeClipboardText,
} from "./clipboard";

/** Temporarily replaces `globalThis.navigator` for one test body. */
async function withNavigator(
  value: unknown,
  body: () => Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
  try {
    await body();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

/** Secure contexts keep using the async Clipboard API for both directions. */
test("clipboard helpers use the async Clipboard API when it exists", async () => {
  let written = "";
  await withNavigator(
    {
      clipboard: {
        writeText: async (text: string) => {
          written = text;
        },
        readText: async () => "pasted",
      },
    },
    async () => {
      await writeClipboardText("copied");
      assert.equal(written, "copied");
      assert.equal(await readClipboardText(), "pasted");
    },
  );
});

/** Plain-HTTP LAN pages have no Clipboard API, and without a DOM there is no fallback either. */
test("clipboard helpers report unavailability without the Clipboard API", async () => {
  await withNavigator({}, async () => {
    await assert.rejects(readClipboardText(), ClipboardUnavailableError);
    await assert.rejects(writeClipboardText("x"), ClipboardUnavailableError);
  });
});
