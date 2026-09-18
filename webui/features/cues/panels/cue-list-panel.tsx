// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { CueListView } from "../components/cue-list-view";
import { createCueListController } from "../controllers/cue-list-controller";

interface CueListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered cue-list panel to its feature controller and view. */
export default function CueListPanel(props: CueListPanelProps) {
  const controller = createCueListController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <CueListView controller={controller} />;
}
