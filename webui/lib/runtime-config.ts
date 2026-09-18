// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { EngineRuntimeConfig } from "./engine-runtime-protocol";

/** Stable identifier for the release-owned browser demo sample. */
export const BROWSER_DEMO_SAMPLE_ID = "nightfall-demo-v1";

const BROWSER_DEMO_SHOWFILE_PATH =
  "nightfall-demo.nightfall-show/showfile.json";

/** Resolve the immutable demo showfile beneath one deployed application base. */
export function resolveBrowserDemoShowfileUrl(
  basePath: string,
  documentUrl: string,
): string {
  const applicationBaseUrl = new URL(basePath, documentUrl);
  return new URL(BROWSER_DEMO_SHOWFILE_PATH, applicationBaseUrl).href;
}

/** Returns whether the current page explicitly selected the embedded demo runtime. */
export function isEmbeddedDemoRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return (
    import.meta.env.MODE === "browser-demo" ||
    new URLSearchParams(window.location.search).get("engine") ===
      "embedded-demo"
  );
}

/** Builds the runtime configuration selected by the current page URL. */
export function configuredEngineRuntime(
  websocketUrl: string,
): EngineRuntimeConfig {
  if (isEmbeddedDemoRuntime()) {
    return {
      mode: "embedded-demo",
      sampleId: BROWSER_DEMO_SAMPLE_ID,
      showfileUrl: resolveBrowserDemoShowfileUrl(
        import.meta.env.BASE_URL,
        window.location.href,
      ),
    };
  }
  return { mode: "remote", websocketUrl };
}
