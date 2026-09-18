// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { ClipListController } from "../controllers/clip-list-controller";

interface ClipListPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Provides the registered panel boundary for the clip feature controller. */
export default function ClipListPanel(props: ClipListPanelProps) {
  return <ClipListController panelId={props.initialPanelId ?? props.id} />;
}
