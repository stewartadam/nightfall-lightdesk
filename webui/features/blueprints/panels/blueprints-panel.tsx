// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { BlueprintsView } from "../components/blueprints-view";
import { createBlueprintsController } from "../controllers/blueprints-controller";

export interface BlueprintsPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered blueprints panel to its controller and view. */
export default function BlueprintsPanel(props: BlueprintsPanelProps) {
  const controller = createBlueprintsController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <BlueprintsView controller={controller} />;
}
