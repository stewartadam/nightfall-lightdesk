// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { IoTransportsController } from "../controllers/io-transports-controller";

export interface IoTransportsPanelProps extends BasePanelComponentProps {}

/** Provides the registered panel boundary for I/O transport coordination. */
export default function IoTransportsPanel(_props: IoTransportsPanelProps) {
  return <IoTransportsController />;
}
