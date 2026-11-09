// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  openOrFocusPanelDefinition,
  type PanelOpenDockApi,
} from "../../lib/panel-open-command";
import fixturesPanelDefinition from "./panels/fixtures.definition";
import { setFixturesShowOnlyParked } from "./state/panel-settings";

/**
 * Opens or focuses the Fixtures panel with its parked-only view on, so the operator sees just the
 * parked fixtures and attributes.
 */
export function showParkedFixtures(api: PanelOpenDockApi | undefined): void {
  setFixturesShowOnlyParked(true);
  openOrFocusPanelDefinition(api, fixturesPanelDefinition);
}
