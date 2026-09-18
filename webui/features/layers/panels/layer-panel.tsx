// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { LayerPanelController } from "../controllers/layer-panel-controller";

/** Mounts the layer feature coordinator at the registered panel boundary. */
export default function LayerPanel(props: BasePanelComponentProps) {
  return <LayerPanelController {...props} />;
}
