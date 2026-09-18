// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  LayerViewController,
  type LayerViewProps,
} from "../controllers/layer-view-controller";

/** Mounts the layer-grid controller behind the feature presentation boundary. */
export default function LayerView(props: LayerViewProps) {
  return <LayerViewController {...props} />;
}
