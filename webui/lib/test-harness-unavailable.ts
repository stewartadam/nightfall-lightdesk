// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Stands in for the e2e harness registry in shipped builds, where
 * `vite.config.ts` resolves every import of the registry here so no harness
 * chunk is emitted.
 */
export function loadHarness(_name: string): Promise<never> {
  return Promise.reject(
    new Error("E2E harnesses are only bundled into dev servers and e2e builds"),
  );
}
