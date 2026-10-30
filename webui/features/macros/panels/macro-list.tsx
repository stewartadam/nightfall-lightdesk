// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { MacroListView } from "../components/macro-list-view";
import { createMacroListController } from "../controllers/macro-list-controller";

/** Connects the registered Macros panel to its controller and view. */
export default function MacroListPanel(props: BasePanelComponentProps) {
  const controller = createMacroListController({ panelId: props.id });
  return <MacroListView controller={controller} />;
}
