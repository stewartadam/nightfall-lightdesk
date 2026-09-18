// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exportDiagnostics } from "./diagnostics-export";

/** Verifies native export awaits the backend and preserves native errors for the dialog. */
test("desktop diagnostics invoke native export with selections and no log contents", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[] = [];
  let fail = false;
  let cancel = false;
  let warnings = ["Missing referenced audio"];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        /** Implements the Tauri IPC boundary without any browser download APIs. */
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          if (cancel) return null;
          if (fail) throw new Error("Downloads is read-only");
          return {
            path: "/Users/example/Downloads/nightfall-diagnostics-unique.zip",
            warnings,
          };
        },
      },
    },
  });
  try {
    const options = {
      systemInfo: '{"application":"Nightfall"}',
      logMode: "all",
      logLength: 400000,
      showfileMode: "allReferences",
    } as const;
    assert.equal(
      await exportDiagnostics(options),
      "1 file(s) could not be included; see manifest.json in the ZIP for details.",
    );
    assert.deepEqual(calls, [
      { command: "export_diagnostics", args: { options } },
    ]);
    warnings = [];
    assert.equal(await exportDiagnostics(options), "");
    cancel = true;
    assert.equal(await exportDiagnostics(options), "");
    cancel = false;
    fail = true;
    await assert.rejects(exportDiagnostics(options), /Downloads is read-only/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
