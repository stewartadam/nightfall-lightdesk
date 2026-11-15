// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelCapabilityContract } from "./types";

export const REVEAL_LIBRARY_FIXTURE_CAPABILITY: PanelCapabilityContract<
  "reveal-library-fixture",
  {
    make: string;
    model: string;
    asset_etag: string;
  }
> = {
  id: "reveal-library-fixture",
  description:
    "Reveal and select one revision of a fixture definition in the fixture library.",
};

export type RevealLibraryFixtureCapability =
  typeof REVEAL_LIBRARY_FIXTURE_CAPABILITY;
