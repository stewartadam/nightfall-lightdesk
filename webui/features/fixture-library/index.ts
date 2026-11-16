// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { REVEAL_LIBRARY_FIXTURE_CAPABILITY } from "../../lib/panel-capabilities";
import type { PanelCapabilityRegistry } from "../../lib/panel-capability-registry";
import {
  openOrFocusPanelDefinition,
  type PanelOpenDockApi,
} from "../../lib/panel-open-command";
import fixtureLibraryPanelDefinition from "./panels/fixture-library.definition";

export { default as LibraryFixturePreview } from "./components/library-fixture-preview";

/**
 * Opens or focuses the Fixture Library and selects one revision of a fixture definition,
 * showing it in Properties. Takes the panel capability registry's invoke, which queues the
 * request until a newly opened library panel can take it.
 */
export function revealInFixtureLibrary(
  api: PanelOpenDockApi | undefined,
  invokePanelCapability: PanelCapabilityRegistry["invokePanelCapability"],
  revision: { make: string; model: string; asset_etag: string },
): void {
  openOrFocusPanelDefinition(api, fixtureLibraryPanelDefinition);
  invokePanelCapability(
    fixtureLibraryPanelDefinition.panelId,
    REVEAL_LIBRARY_FIXTURE_CAPABILITY,
    revision,
  );
}
