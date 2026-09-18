// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { engineRuntime, getWebSocketUrl } from "../../../lib/engine-runtime";
import {
  configuredEngineRuntime,
  isEmbeddedDemoRuntime,
} from "../../../lib/runtime-config";
import { Button } from "../../ui/visual-language/button";

/** Keeps the demo reset action available in the application toolbar. */
export default function BrowserDemoBanner() {
  /** Replaces the embedded world with a freshly seeded deterministic sample. */
  const resetDemo = () => {
    engineRuntime.stop();
    engineRuntime.start(configuredEngineRuntime(getWebSocketUrl()));
  };

  return (
    <Show when={isEmbeddedDemoRuntime()}>
      <aside
        class="nf-browser-demo-banner flex shrink-0 items-center gap-3"
        data-testid="browser-demo-banner"
      >
        <Button
          size="compact"
          variant="primary"
          type="button"
          data-testid="browser-demo-reset"
          onClick={resetDemo}
        >
          Reset demo
        </Button>
      </aside>
    </Show>
  );
}
