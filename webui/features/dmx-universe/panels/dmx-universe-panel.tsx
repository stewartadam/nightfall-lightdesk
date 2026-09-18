// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { DmxUniverseController } from "../controllers/dmx-universe-controller";

export interface DmxUniversePanelProps extends BasePanelComponentProps {}

/** Connects the registered DMX universe panel to its feature controller. */
export default function DmxUniversePanel(props: DmxUniversePanelProps) {
  return (
    <DmxUniverseController
      id={props.id}
      initialPanelId={props.initialPanelId as string | undefined}
    />
  );
}
