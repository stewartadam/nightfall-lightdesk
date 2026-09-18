// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { SequenceListView } from "../components/sequence-list-view";
import { createSequenceListController } from "../controllers/sequence-list-controller";

interface SequenceListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Connects the registered sequence-list panel to its controller and view. */
export default function SequenceListPanel(props: SequenceListPanelProps) {
  const controller = createSequenceListController({
    id: props.id,
    initialPanelId: props.initialPanelId,
  });
  return <SequenceListView controller={controller} />;
}
