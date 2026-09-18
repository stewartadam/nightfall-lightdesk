// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Verify release notices are deployed under the app base and included in the integrity manifest. */
test("browser release ships dependency notice files", async ({ request }) => {
  test.skip(
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE !== "preview",
    "Requires the packaged browser-demo artifact",
  );
  const response = await request.get(
    "/demo/app/notices/THIRD-PARTY-NOTICES.json",
  );
  expect(response.ok()).toBe(true);
  const notices = await response.json();
  expect(notices.distribution).toBe("Web — frontend and WebAssembly");
  const names = notices.entries.map((entry: { name: string }) => entry.name);
  for (const name of [
    "solid-js",
    "three",
    "preline",
    "cborg",
    "bevy_ecs",
    "tailwindcss",
    "tw-animate-css",
  ])
    expect(names).toContain(name);
  expect(names).not.toContain("tauri");
  const text = await request.get("/demo/app/notices/THIRD-PARTY-NOTICES.txt");
  expect(text.ok()).toBe(true);
  expect(await text.text()).toContain("Preline UI Fair Use License");
  const manifest = await (
    await request.get("/demo/app/browser-demo-manifest.json")
  ).json();
  expect(manifest.files["notices/THIRD-PARTY-NOTICES.txt"].sha256).toMatch(
    /^[0-9a-f]{64}$/,
  );
});
