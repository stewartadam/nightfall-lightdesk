// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { FxListView } from "../components/fx-list-view";
import { createFxListController } from "../controllers/fx-list-controller";

interface FxListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered FX-list panel to its feature controller and view. */
export default function FxListPanel(props: FxListPanelProps) {
  const controller = createFxListController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <FxListView controller={controller} />;
}
